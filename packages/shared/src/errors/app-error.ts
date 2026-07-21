export abstract class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;

    // Explicitly restore the prototype chain. When extending built-ins like
    // `Error` and compiling down to a target where classes are transpiled to
    // functions, `instanceof` checks against subclasses can otherwise break.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
