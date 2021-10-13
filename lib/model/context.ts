export interface Context {
  timeout?: number,
  maxRetries?: number,
  attemptNr?: number,
  correlationId?: string,
  messageId?: string,
  clientMessageId?: string,
  routingKey?: string,
  timestamp?: number,
  ip?: string,
  userAgent?: string,
  expiredAt?: number,
  origin?: string,
  signature?: string
}
