/** Transport loss is not evidence that the executor (or its children) exited. */
export class ExecutionUncertainError extends Error {
  constructor(message: string) { super(message); this.name = "ExecutionUncertainError"; }
}
