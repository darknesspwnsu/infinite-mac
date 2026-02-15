import {type EmulatorCDROM} from "@/emulator/common/common";
import allowedDomains from "@/defs/cdrom-sites.json";

type CDROMSpec = {
    srcUrl: string;
    totalSize?: number;
};

const CDROM_CHUNK_TIMEOUT_MS = 15_000;
const CDROM_PROBE_TIMEOUT_MS = 10_000;

export async function handleRequest(path: string, method: string) {
    const pathPieces = path.split("/");
    const encodedSpec = pathPieces[2];
    let specStr;
    try {
        // CD-ROM specs are encoded into the URL path segment. Decode URI
        // escapes first so encoded "/" characters from base64 are preserved.
        specStr = atob(decodeURIComponent(encodedSpec));
    } catch (e) {
        return errorResponse("Malformed CD-ROM spec: " + encodedSpec);
    }

    let spec: CDROMSpec;
    if (specStr.startsWith("{")) {
        try {
            spec = JSON.parse(specStr);
        } catch (e) {
            return errorResponse("Malformed CD-ROM spec: " + specStr);
        }
    } else {
        // Simple spec, just a URL.
        spec = {srcUrl: specStr};
    }

    if (!isValidSrcUrl(spec.srcUrl)) {
        return errorResponse("Unexpected CD-ROM src URL: " + spec.srcUrl);
    }

    if (method === "GET") {
        return await handleGET(pathPieces, spec);
    }
    if (method === "PUT") {
        return await handlePUT(spec.srcUrl);
    }

    return errorResponse("Method not allowed", 405);
}

// Don't want to become a proxy for arbitrary URLs
export function isValidSrcUrl(srcUrl: string) {
    let srcUrlParsed;
    try {
        srcUrlParsed = new URL(srcUrl);
    } catch (e) {
        return false;
    }
    const {protocol: srcProtocol, host: srcHost} = srcUrlParsed;
    if (srcProtocol !== "https:") {
        return false;
    }

    // Allow signed launcher proxy URLs from Vercel deployments.
    // This keeps previews functional while still constraining to the expected
    // endpoint shape.
    if (
        srcHost.endsWith(".vercel.app") &&
        srcUrlParsed.pathname === "/api/disk-stream" &&
        srcUrlParsed.searchParams.has("token")
    ) {
        return true;
    }

    for (const allowedDomain of allowedDomains) {
        if (
            srcHost === allowedDomain ||
            srcHost.endsWith("." + allowedDomain)
        ) {
            return true;
        }
    }
    return false;
}

async function handleGET(pathPieces: string[], spec: CDROMSpec) {
    const chunkMatch = /(\d+)-(\d+).chunk$/.exec(pathPieces[3]);
    if (!chunkMatch) {
        return errorResponse("Malformed CD-ROM src chunk: " + pathPieces[3]);
    }

    const chunkStart = parseInt(chunkMatch[1]);
    const chunkEnd = parseInt(chunkMatch[2]);

    let chunkFetchError;
    for (let retry = 0; retry < 3; retry++) {
        try {
            const {chunk, contentLength} = await fetchChunk(
                spec,
                chunkStart,
                chunkEnd
            );
            return new Response(chunk, {
                status: 200,
                headers: {
                    "Content-Type": "multipart/mixed",
                    "Content-Length": String(contentLength),
                    // Always allow caching (mirrors logic for our own disk chunks).
                    "Cache-Control": `public, max-age=${
                        60 * 60 * 24 * 30
                    }, immutable`,
                },
            });
        } catch (e) {
            chunkFetchError = e;
        }
    }

    console.warn("CD-ROM fetch failed", {
        ...spec,
        chunkStart,
        chunkEnd,
        chunkFetchError,
    });
    return errorResponse("CD-ROM fetch failed: " + chunkFetchError, 500);
}

/**
 * Generates a CD-ROM manifest from a source URL on the fly, equivalent to what
 * get_output_manifest from import-cd-roms.py does.
 */
async function handlePUT(srcUrl: string) {
    const fileSizeResult = await probeCDROMFileSize(srcUrl);
    if (!fileSizeResult.ok) {
        return errorResponse(fileSizeResult.error);
    }
    const fileSize = fileSizeResult.fileSize;

    // It would be nice to also check that the Accept-Ranges header contains
    // `bytes`, but it seems to be stripped from the response when running in
    // a Cloudflare Worker.

    const cdrom: EmulatorCDROM = {
        // The name is not that important, but try to use the filename from the
        // URL if possible.
        name: new URL(srcUrl).pathname.split("/").pop() ?? "Untitled",
        srcUrl,
        fileSize,
        // Cover images are not shown for on-demand CD-ROMs, so leave them
        // blank.
        coverImageHash: "",
        coverImageSize: [0, 0],
    };
    if (srcUrl.endsWith(".bin")) {
        cdrom.mode = "MODE1/2352";
    }
    if (srcUrl.endsWith(".dsk")) {
        cdrom.mountReadWrite = true;
    }
    return new Response(JSON.stringify(cdrom), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
        },
    });
}

type ProbeResult =
    | {
          ok: true;
          fileSize: number;
      }
    | {
          ok: false;
          error: string;
      };

function parsePositiveInt(value: string | null): number | null {
    if (!value) {
        return null;
    }
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function parseSizeFromContentRange(value: string | null): number | null {
    if (!value) {
        return null;
    }
    const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(value);
    if (!match?.[1]) {
        return null;
    }
    return parsePositiveInt(match[1]);
}

async function probeCDROMFileSize(srcUrl: string): Promise<ProbeResult> {
    const headers = {
        "User-Agent": "Infinite Mac (+https://infinitemac.org)",
    };

    try {
        const headResponse = await fetch(srcUrl, {
            method: "HEAD",
            headers,
            signal: AbortSignal.timeout(CDROM_PROBE_TIMEOUT_MS),
        });
        if (headResponse.ok) {
            const fileSize = parsePositiveInt(
                headResponse.headers.get("Content-Length")
            );
            if (fileSize !== null) {
                return {ok: true, fileSize};
            }
        }
    } catch {
        // Fall through to ranged GET probe.
    }

    try {
        const rangeResponse = await fetch(srcUrl, {
            method: "GET",
            headers: {
                ...headers,
                Range: "bytes=0-0",
            },
            signal: AbortSignal.timeout(CDROM_PROBE_TIMEOUT_MS),
        });
        if (!rangeResponse.ok) {
            return {
                ok: false,
                error: `CD-ROM probe request failed: ${rangeResponse.status} (${rangeResponse.statusText})`,
            };
        }
        const rangedSize = parseSizeFromContentRange(
            rangeResponse.headers.get("Content-Range")
        );
        if (rangedSize !== null) {
            return {ok: true, fileSize: rangedSize};
        }
        const fullSize = parsePositiveInt(
            rangeResponse.headers.get("Content-Length")
        );
        if (fullSize !== null) {
            return {ok: true, fileSize: fullSize};
        }
        return {
            ok: false,
            error: "CD-ROM probe request failed: missing size headers",
        };
    } catch (error) {
        return {
            ok: false,
            error:
                error instanceof Error
                    ? `CD-ROM probe request failed: ${error.message}`
                    : "CD-ROM probe request failed",
        };
    }
}

async function fetchChunk(
    spec: CDROMSpec,
    chunkStart: number,
    chunkEnd: number
) {
    // Don't allow Cloudflare to cache requests in large files, since it will attempt
    // to read the entire file (as opposed to just the range that we requested).
    const isLargeFile =
        spec.totalSize !== undefined && spec.totalSize > 250 * 1024 * 1024;
    const cacheOptions: Partial<RequestInit<RequestInitCfProperties>> =
        isLargeFile
            ? {cache: "no-store"}
            : {
                  cf: {
                      cacheEverything: true,
                      cacheTtl: 30 * 24 * 60 * 60,
                  },
              };
    const srcRes = await fetch(spec.srcUrl, {
        headers: {
            "User-Agent": "Infinite Mac (+https://infinitemac.org)",
            "Range": `bytes=${chunkStart}-${chunkEnd}`,
        },
        ...cacheOptions,
        signal: AbortSignal.timeout(CDROM_CHUNK_TIMEOUT_MS),
    });

    if (!srcRes.ok) {
        throw new Error(
            "Error response: " + srcRes.status + "/" + srcRes.statusText
        );
    }

    const srcBody = await srcRes.arrayBuffer();
    return {
        chunk: srcBody,
        contentLength: srcBody.byteLength,
    };
}

function errorResponse(message: string, status: number = 400): Response {
    return new Response(message, {
        status,
        statusText: message,
        headers: {"Content-Type": "text/plain"},
    });
}
