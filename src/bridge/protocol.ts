import type { ObservationEnvelope } from "../observation/router.js";

export type BridgeRequest =
  | {
      id: string;
      type: "initialize";
      configPath?: string;
      root?: string;
      resultDir?: string;
    }
  | {
      id: string;
      type: "reset";
      episodeId: string;
      taskDate?: string;
    }
  | {
      id: string;
      type: "predict";
      episodeId: string;
      instruction: string;
      step: number;
      observation: ObservationEnvelope;
    }
  | { id: string; type: "close" };

export type BridgeResponse =
  | { id: string; ok: true; result: { response: string; actions: string[] } }
  | { id: string; ok: true; result: "ok" }
  | { id: string; ok: false; error: string };
