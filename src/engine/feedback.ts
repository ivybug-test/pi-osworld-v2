// ---------------------------------------------------------------------------
// 同轮反馈注入（可插拔模块）：
// 生产方（orchestrator 的周期审计 / 未来 verifier）只负责 offer(text)；
// 消费方（backend interior loop）在每次模型调用前 takePending() 把缓冲合入
// 角色上下文（refresh_state 角色走 transform 合并，其余角色追加一条 user 消息）。
// 模块不感知 audit/verifier 语义，任何"运行中产出的指引"都可复用。
// ---------------------------------------------------------------------------

/**
 * 反馈注入缓冲。
 *
 * 生命周期：每个主角色 episode 由 backend 创建一次；round 开始时用持久化的
 * 待注入反馈 seed，round 中途由 orchestrator 通过 onTurn 的 sink 参数 offer。
 * 消费方取走后清空，保证同一段反馈只注入一次。
 */
export class FeedbackInjector {
  private pending: string[] = [];

  /** 生产方：放入一段反馈文本（空白忽略；多次 offer 会合并为一条注入）。 */
  offer(text: string | undefined): void {
    const trimmed = text?.trim();
    if (trimmed) this.pending.push(trimmed);
  }

  /** 消费方：取走并清空全部缓冲；没有待注入内容时返回 undefined。 */
  takePending(): string | undefined {
    if (this.pending.length === 0) return undefined;
    return this.pending.splice(0).join("\n\n");
  }

  /** 缓冲中是否还有未消费的反馈。 */
  get hasPending(): boolean {
    return this.pending.length > 0;
  }
}
