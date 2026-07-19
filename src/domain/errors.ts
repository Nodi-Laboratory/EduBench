export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DomainError';
  }
}

