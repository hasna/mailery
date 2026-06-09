export class CerebrasError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
  ) {
    super(message);
    this.name = "CerebrasError";
  }
}
