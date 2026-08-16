/** 具型別的錯誤，讓呼叫端能區分「使用者給錯東西」與「外部工具爆了」。 */

export class PlanValidationError extends Error {
  override readonly name = 'PlanValidationError';
}

export class ExternalToolError extends Error {
  override readonly name = 'ExternalToolError';
  readonly tool: string;
  readonly exitCode: number | null;

  constructor(tool: string, exitCode: number | null, message: string) {
    super(message);
    this.tool = tool;
    this.exitCode = exitCode;
  }
}
