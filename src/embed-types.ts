/** Events that can be sent to an embedded emulator instance to control it. */
export type EmbedControlEvent =
    | {
          type: "emulator_pause";
      }
    | {
          type: "emulator_unpause";
      }
    | {
          type: "emulator_request_audio_resume";
      }
    | {
          type: "emulator_mouse_move";
          /**
           * Some emulators (Mini vMac, Basilisk II, SheepShaver) support
           * absolute coordinates.
           */
          x: number;
          y: number;
          /**
           * Others (Previous, DingusPPC, PearPC) only support relative
           * coordinates.
           */
          deltaX: number;
          deltaY: number;
      }
    | {
          type: "emulator_mouse_down";
          /** Button 0 is left, 1 is middle, 2 is right. */
          button: number;
      }
    | {
          type: "emulator_mouse_up";
          /** Button 0 is left, 1 is middle, 2 is right. */
          button: number;
      }
    | {
          type: "emulator_key_down";
          /** Physical key code, as reported to JavaScript */
          code: string;
      }
    | {
          type: "emulator_key_up";
          /** Physical key code, as reported to JavaScript */
          code: string;
      }
    | {
          type: "emulator_load_disk";
          url: string;
      }
    | {
          type: "emulator_state_slots_query";
      }
    | {
          type: "emulator_state_slot_save";
          slotIndex: 1 | 2 | 3;
      }
    | {
          type: "emulator_state_slot_load";
          slotIndex: 1 | 2 | 3;
      }
    | {
          type: "emulator_state_slot_delete";
          slotIndex: 1 | 2 | 3;
      };

/** Events that are sent from the embedded emulator instance to the parent page */
export type EmbedNotificationEvent =
    | {
          type: "emulator_loaded";
      }
    | {
          type: "emulator_audio_gate_ack";
      }
    | {
          type: "emulator_audio_open";
          sampleRate: number;
          sampleSize: number;
          channels: number;
      }
    | {
          type: "emulator_audio_running";
      }
    | {
          type: "emulator_audio_blocked";
      }
    | {
          type: "emulator_audio_activity";
          bytesPerSecond: number;
      }
    | {
          type: "emulator_audio_probe";
          bytesPerSecond: number;
          rms: number;
          clipped: boolean;
          source: "shared" | "fallback";
      }
    | {
          type: "emulator_audio_debug";
          bytesPerSecond: number;
          rms: number;
          clipped: boolean;
          source: "shared" | "fallback";
          audioContextRunningFlagSeen: boolean;
          workerEnqueueCount: number;
          workerDroppedBeforeGateCount: number;
          mixerActive: boolean;
          numSources: number;
          sampleCountLastInterrupt: number;
      }
    | {
          type: "emulator_chunk_fetch_error";
          chunkUrl: string;
          chunkIndex: number;
          statusOrError: string;
          fatal: boolean;
      }
    | {
          type: "emulator_av_resync_applied";
          reason: "blur" | "hidden" | "freeze" | "manual";
          droppedAudioMs: number;
      }
    | {
          type: "emulator_audio_queue_stats";
          bufferedMs: number;
          droppedChunks: number;
          mode: "shared" | "fallback";
      }
    | {
          type: "emulator_disk_mount_succeeded";
          url: string;
      }
    | {
          type: "emulator_disk_mount_failed";
          url: string;
          message: string;
      }
    | {
          type: "emulator_error";
          message: string;
      }
    | {
          type: "emulator_state_capabilities";
          supported: boolean;
          reason?: string;
          slotCount: 3;
      }
    | {
          type: "emulator_state_slots";
          slots: Array<{
              slotIndex: 1 | 2 | 3;
              exists: boolean;
              savedAtIso?: string;
          }>;
      }
    | {
          type: "emulator_state_action_result";
          action: "save" | "load" | "delete";
          slotIndex: 1 | 2 | 3;
          ok: boolean;
          message?: string;
      }
    | {
          type: "emulator_screen";
          data: Uint8ClampedArray;
          width: number;
          height: number;
      };
