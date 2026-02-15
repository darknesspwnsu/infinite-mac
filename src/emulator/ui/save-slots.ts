export type SaveStateSlotIndex = 1 | 2 | 3;

export type SaveStateSlotSummary = {
    slotIndex: SaveStateSlotIndex;
    exists: boolean;
    savedAtIso?: string;
};

export type SaveStateCapabilities = {
    supported: boolean;
    reason?: string;
    slotCount: 3;
};

type SaveStateManifest = {
    savedAtIso: string;
};

const SLOT_INDICES: readonly SaveStateSlotIndex[] = [1, 2, 3];
const SLOT_ROOT_NAME = "factory-state-slots-v1";
const SLOT_FILES_DIR_NAME = "files";
const SLOT_MANIFEST_FILE_NAME = "manifest.json";

const emptySlotSummary = (slotIndex: SaveStateSlotIndex): SaveStateSlotSummary => ({
    slotIndex,
    exists: false,
});

const emptySlotSummaries = (): SaveStateSlotSummary[] =>
    SLOT_INDICES.map(slotIndex => emptySlotSummary(slotIndex));

const asStorageWithDirectory = (
    storage: StorageManager
): (StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}) => storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

const getOpfsRoot = async (): Promise<FileSystemDirectoryHandle> => {
    const storage = asStorageWithDirectory(navigator.storage);
    if (typeof storage.getDirectory !== "function") {
        throw new Error("OPFS is unavailable in this browser.");
    }
    return await storage.getDirectory();
};

const readFileText = async (handle: FileSystemFileHandle): Promise<string> => {
    const file = await handle.getFile();
    return await file.text();
};

const writeFileText = async (
    directory: FileSystemDirectoryHandle,
    fileName: string,
    contents: string
): Promise<void> => {
    const fileHandle = await directory.getFileHandle(fileName, {create: true});
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
};

const tryGetDirectoryHandle = async (
    parent: FileSystemDirectoryHandle,
    name: string
): Promise<FileSystemDirectoryHandle | null> => {
    try {
        return await parent.getDirectoryHandle(name);
    } catch (err) {
        if (err instanceof DOMException && err.name === "NotFoundError") {
            return null;
        }
        throw err;
    }
};

const tryGetFileHandle = async (
    parent: FileSystemDirectoryHandle,
    name: string
): Promise<FileSystemFileHandle | null> => {
    try {
        return await parent.getFileHandle(name);
    } catch (err) {
        if (err instanceof DOMException && err.name === "NotFoundError") {
            return null;
        }
        throw err;
    }
};

const removeEntryIfExists = async (
    parent: FileSystemDirectoryHandle,
    name: string,
    recursive: boolean
): Promise<void> => {
    try {
        await parent.removeEntry(name, {recursive});
    } catch (err) {
        if (err instanceof DOMException && err.name === "NotFoundError") {
            return;
        }
        throw err;
    }
};

const clearDirectory = async (directory: FileSystemDirectoryHandle): Promise<void> => {
    for await (const [name, handle] of directoryEntries(directory)) {
        if (handle.kind === "directory") {
            await removeEntryIfExists(directory, name, true);
        } else {
            await removeEntryIfExists(directory, name, false);
        }
    }
};

const copyFile = async (
    source: FileSystemFileHandle,
    targetDirectory: FileSystemDirectoryHandle,
    name: string
): Promise<void> => {
    const sourceFile = await source.getFile();
    const targetHandle = await targetDirectory.getFileHandle(name, {create: true});
    const writable = await targetHandle.createWritable();
    await writable.write(await sourceFile.arrayBuffer());
    await writable.close();
};

const copyDirectoryContents = async (
    sourceDirectory: FileSystemDirectoryHandle,
    targetDirectory: FileSystemDirectoryHandle
): Promise<void> => {
    for await (const [name, handle] of directoryEntries(sourceDirectory)) {
        if (handle.kind === "directory") {
            const nestedTarget = await targetDirectory.getDirectoryHandle(name, {
                create: true,
            });
            await clearDirectory(nestedTarget);
            await copyDirectoryContents(
                handle as FileSystemDirectoryHandle,
                nestedTarget
            );
            continue;
        }

        await copyFile(handle as FileSystemFileHandle, targetDirectory, name);
    }
};

const readSlotManifest = async (
    slotDirectory: FileSystemDirectoryHandle
): Promise<SaveStateManifest | null> => {
    const manifestHandle = await tryGetFileHandle(
        slotDirectory,
        SLOT_MANIFEST_FILE_NAME
    );
    if (!manifestHandle) {
        return null;
    }

    try {
        const parsed = JSON.parse(
            await readFileText(manifestHandle)
        ) as Partial<SaveStateManifest>;
        if (typeof parsed.savedAtIso !== "string") {
            return null;
        }
        return {
            savedAtIso: parsed.savedAtIso,
        };
    } catch {
        return null;
    }
};

const writeSlotManifest = async (
    slotDirectory: FileSystemDirectoryHandle,
    manifest: SaveStateManifest
): Promise<void> => {
    await writeFileText(
        slotDirectory,
        SLOT_MANIFEST_FILE_NAME,
        JSON.stringify(manifest, null, 2)
    );
};

const getSlotsRoot = async (
    root: FileSystemDirectoryHandle,
    create: boolean
): Promise<FileSystemDirectoryHandle | null> => {
    if (create) {
        return await root.getDirectoryHandle(SLOT_ROOT_NAME, {create: true});
    }
    return await tryGetDirectoryHandle(root, SLOT_ROOT_NAME);
};

const getSlotDirectoryName = (slotIndex: SaveStateSlotIndex): string =>
    `slot-${slotIndex}`;

const getSlotDirectory = async (
    slotsRoot: FileSystemDirectoryHandle,
    slotIndex: SaveStateSlotIndex,
    create: boolean
): Promise<FileSystemDirectoryHandle | null> => {
    if (create) {
        return await slotsRoot.getDirectoryHandle(getSlotDirectoryName(slotIndex), {
            create: true,
        });
    }
    return await tryGetDirectoryHandle(slotsRoot, getSlotDirectoryName(slotIndex));
};

const copyRuntimeDataToSlot = async (
    root: FileSystemDirectoryHandle,
    slotFilesDir: FileSystemDirectoryHandle
): Promise<void> => {
    await clearDirectory(slotFilesDir);
    for await (const [name, handle] of directoryEntries(root)) {
        if (name === SLOT_ROOT_NAME) {
            continue;
        }
        if (handle.kind === "directory") {
            const nestedTarget = await slotFilesDir.getDirectoryHandle(name, {
                create: true,
            });
            await clearDirectory(nestedTarget);
            await copyDirectoryContents(
                handle as FileSystemDirectoryHandle,
                nestedTarget
            );
            continue;
        }
        await copyFile(handle as FileSystemFileHandle, slotFilesDir, name);
    }
};

const clearRuntimeData = async (root: FileSystemDirectoryHandle): Promise<void> => {
    for await (const [name, handle] of directoryEntries(root)) {
        if (name === SLOT_ROOT_NAME) {
            continue;
        }
        if (handle.kind === "directory") {
            await removeEntryIfExists(root, name, true);
        } else {
            await removeEntryIfExists(root, name, false);
        }
    }
};

const copySlotToRuntimeData = async (
    slotFilesDir: FileSystemDirectoryHandle,
    runtimeRoot: FileSystemDirectoryHandle
): Promise<void> => {
    await clearRuntimeData(runtimeRoot);
    await copyDirectoryContents(slotFilesDir, runtimeRoot);
};

const directoryEntries = (
    directory: FileSystemDirectoryHandle
): AsyncIterable<[string, FileSystemHandle]> => {
    const entries = (
        directory as unknown as {
            entries?: () => AsyncIterable<[string, FileSystemHandle]>;
        }
    ).entries;
    if (!entries) {
        throw new Error("Directory iteration is unavailable.");
    }
    return entries.call(directory);
};

export const getSaveStateCapabilities = async (): Promise<SaveStateCapabilities> => {
    try {
        await getOpfsRoot();
        return {
            supported: true,
            slotCount: 3,
        };
    } catch (err) {
        return {
            supported: false,
            reason: err instanceof Error ? err.message : "OPFS is unavailable.",
            slotCount: 3,
        };
    }
};

export const querySaveStateSlots = async (): Promise<SaveStateSlotSummary[]> => {
    const capabilities = await getSaveStateCapabilities();
    if (!capabilities.supported) {
        return emptySlotSummaries();
    }

    const root = await getOpfsRoot();
    const slotsRoot = await getSlotsRoot(root, false);
    if (!slotsRoot) {
        return emptySlotSummaries();
    }

    const summaries: SaveStateSlotSummary[] = [];
    for (const slotIndex of SLOT_INDICES) {
        const slotDirectory = await getSlotDirectory(slotsRoot, slotIndex, false);
        if (!slotDirectory) {
            summaries.push(emptySlotSummary(slotIndex));
            continue;
        }

        const manifest = await readSlotManifest(slotDirectory);
        if (!manifest) {
            summaries.push(emptySlotSummary(slotIndex));
            continue;
        }

        summaries.push({
            slotIndex,
            exists: true,
            savedAtIso: manifest.savedAtIso,
        });
    }

    return summaries;
};

export const saveStateSlot = async (
    slotIndex: SaveStateSlotIndex
): Promise<SaveStateSlotSummary[]> => {
    const root = await getOpfsRoot();
    const slotsRoot = await getSlotsRoot(root, true);
    if (!slotsRoot) {
        throw new Error("Could not initialize save-state storage.");
    }
    const slotDirectory = await getSlotDirectory(slotsRoot, slotIndex, true);
    if (!slotDirectory) {
        throw new Error(`Slot ${slotIndex} is unavailable.`);
    }

    await clearDirectory(slotDirectory);
    const filesDir = await slotDirectory.getDirectoryHandle(SLOT_FILES_DIR_NAME, {
        create: true,
    });
    await copyRuntimeDataToSlot(root, filesDir);
    await writeSlotManifest(slotDirectory, {
        savedAtIso: new Date().toISOString(),
    });
    return await querySaveStateSlots();
};

export const loadStateSlot = async (
    slotIndex: SaveStateSlotIndex
): Promise<SaveStateSlotSummary[]> => {
    const root = await getOpfsRoot();
    const slotsRoot = await getSlotsRoot(root, false);
    if (!slotsRoot) {
        throw new Error(`Slot ${slotIndex} is empty.`);
    }

    const slotDirectory = await getSlotDirectory(slotsRoot, slotIndex, false);
    if (!slotDirectory) {
        throw new Error(`Slot ${slotIndex} is empty.`);
    }

    const manifest = await readSlotManifest(slotDirectory);
    if (!manifest) {
        throw new Error(`Slot ${slotIndex} is empty.`);
    }

    const filesDir = await tryGetDirectoryHandle(slotDirectory, SLOT_FILES_DIR_NAME);
    if (!filesDir) {
        throw new Error(`Slot ${slotIndex} is empty.`);
    }

    await copySlotToRuntimeData(filesDir, root);
    return await querySaveStateSlots();
};

export const deleteStateSlot = async (
    slotIndex: SaveStateSlotIndex
): Promise<SaveStateSlotSummary[]> => {
    const root = await getOpfsRoot();
    const slotsRoot = await getSlotsRoot(root, false);
    if (!slotsRoot) {
        return emptySlotSummaries();
    }

    await removeEntryIfExists(slotsRoot, getSlotDirectoryName(slotIndex), true);
    return await querySaveStateSlots();
};
