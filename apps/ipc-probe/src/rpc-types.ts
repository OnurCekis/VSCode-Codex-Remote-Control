import { z } from "zod";

export const rpcIdSchema = z.union([z.string(), z.number()]);
export type RpcId = z.infer<typeof rpcIdSchema>;

const rpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const rpcResponseSchema = z.object({
  id: rpcIdSchema,
  result: z.unknown().optional(),
  error: rpcErrorSchema.optional(),
}).refine((message) => ("result" in message) !== ("error" in message), {
  message: "A response must contain exactly one of result or error.",
});

export const rpcRequestSchema = z.object({
  id: rpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const rpcNotificationSchema = z.object({
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type RpcResponse = z.infer<typeof rpcResponseSchema>;
export type RpcRequest = z.infer<typeof rpcRequestSchema>;
export type RpcNotification = z.infer<typeof rpcNotificationSchema>;
export type RpcMessage = RpcRequest | RpcNotification;

export class RpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcRemoteError";
    this.code = code;
    this.data = data;
  }
}

export class RpcProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RpcProtocolError";
  }
}
