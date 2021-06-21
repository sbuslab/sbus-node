// eslint-disable-next-line max-classes-per-file
interface ErrorMessage {
  message: string,
  cause?: Error,
  error?: string,
}

export class GeneralError extends Error {
  readonly code: number;

  // @ts-ignore
  private cause: Error | undefined;

  // @ts-ignore
  readonly error: string | undefined;

  readonly unrecoverable: boolean;

  constructor(code: number, name: string, error: ErrorMessage | string | Error, unrecoverable: boolean = false) {
    if (error instanceof Error) {
      super(error.message);
      this.name = error.name;
      this.message = error.message;
      this.stack = error.stack;
      this.cause = error;
    } else if (typeof error === 'string') {
      super(error);
    } else {
      super(error.message);
      this.message = error.message;
      this.cause = error.cause;
      this.error = error.error;
    }
    this.code = code;
    this.name = name;
    this.unrecoverable = unrecoverable;
  }
}

export class BadRequestError extends GeneralError {
  constructor(error: ErrorMessage | string | Error) {
    super(400, 'BadRequestError', error, true);
  }
}

export class UnauthorizedError extends GeneralError {
  constructor(error: ErrorMessage | string | Error) {
    super(401, 'UnauthorizedError', error, true);
  }
}

export class ForbiddenError extends GeneralError {
  constructor(error: ErrorMessage | string | Error) {
    super(403, 'ForbiddenError', error, true);
  }
}

export class NotFoundError extends GeneralError {
  constructor(error: ErrorMessage | string | Error) {
    super(404, 'NotFoundError', error, true);
  }
}

export class MethodNotAllowedError extends GeneralError {
  constructor(error: ErrorMessage | string | Error) {
    super(405, 'MethodNotAllowedError', error, true);
  }
}

export class ConflictError extends GeneralError {
  constructor(error: ErrorMessage | string | Error) {
    super(409, 'ConflictError', error, true);
  }
}

export class TooManyRequestError extends GeneralError {
  constructor(error: ErrorMessage | string | Error) {
    super(429, 'TooManyRequestError', error);
  }
}

export class InternalServerError extends GeneralError {
  constructor(error: ErrorMessage | string | Error) {
    super(500, 'InternalServerError', error);
  }
}

export class ServiceUnavailableError extends GeneralError {
  constructor(error: ErrorMessage | string | Error) {
    super(503, 'ServiceUnavailableError', error);
  }
}

export function errorFromCode(code: number, body: ErrorMessage | string): GeneralError {
  switch (code) {
    case 400:
      return new BadRequestError(body);
    case 401:
      return new UnauthorizedError(body);
    case 403:
      return new ForbiddenError(body);
    case 404:
      return new NotFoundError(body);
    case 405:
      return new MethodNotAllowedError(body);
    case 409:
      return new ConflictError(body);
    case 429:
      return new TooManyRequestError(body);
    case 500:
      return new InternalServerError(body);
    case 503:
      return new ServiceUnavailableError(body);
    default:
      return new GeneralError(code, 'Unknown', body);
  }
}
