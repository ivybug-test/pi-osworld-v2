import type { BackendId } from "../config/spec.js";
import type { EpisodeRequest, EpisodeResult } from "../engine/types.js";

// ---------------------------------------------------------------------------
// BackendAdapter：执行衬底可互换（DESIGN-v2.md 4.1）
// ---------------------------------------------------------------------------

export interface BackendAdapter {
  readonly id: BackendId;
  runEpisode(req: EpisodeRequest): Promise<EpisodeResult>;
  /** 释放后端资源（如 flush 旧 RunWriter 的 LLM trace）。可选。 */
  close?(): Promise<void>;
  /** 清空某 episode 的跨轮后端状态（serve reset / 重跑同一任务）。可选。 */
  resetEpisode?(episodeId: string): Promise<void>;
}
