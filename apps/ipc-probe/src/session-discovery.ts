import { z } from "zod";
import type { JsonRpcPeer } from "./json-rpc-peer.js";

const threadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("systemError") }),
  z.object({
    type: z.literal("active"),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])),
  }),
]);

const threadSchema = z.object({
  id: z.string(),
  preview: z.string(),
  name: z.string().nullable(),
  cwd: z.string(),
  updatedAt: z.number(),
  status: threadStatusSchema,
  source: z.unknown(),
  canAcceptDirectInput: z.boolean().nullable(),
}).passthrough();

const threadListResponseSchema = z.object({
  data: z.array(threadSchema),
  nextCursor: z.string().nullable(),
});

const loadedListResponseSchema = z.object({
  data: z.array(z.string()),
  nextCursor: z.string().nullable(),
});

const MAX_PROTOCOL_PAGES = 100;

async function collectPages<T>(
  request: (cursor?: string) => Promise<unknown>,
  schema: z.ZodType<{ data: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const collected: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PROTOCOL_PAGES; page += 1) {
    const result = schema.parse(await request(cursor));
    collected.push(...result.data);
    if (result.nextCursor === null) return collected;
    if (seenCursors.has(result.nextCursor)) throw new Error("App Server returned a repeated pagination cursor.");
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`App Server pagination exceeded ${MAX_PROTOCOL_PAGES} pages.`);
}

export type DiscoveredThread = z.infer<typeof threadSchema> & { loaded: boolean };

export async function listLoadedThreadIds(peer: JsonRpcPeer): Promise<Set<string>> {
  return new Set(await collectPages(
    async (cursor) => await peer.request("thread/loaded/list", {
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    }),
    loadedListResponseSchema,
  ));
}

export async function discoverVscodeThreads(
  peer: JsonRpcPeer,
  cwd?: string,
): Promise<DiscoveredThread[]> {
  const [threadResult, loadedResult] = await Promise.all([
    collectPages(
      async (cursor) => await peer.request("thread/list", {
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["vscode"],
        ...(cwd ? { cwd } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      threadListResponseSchema,
    ),
    listLoadedThreadIds(peer),
  ]);

  const loaded = loadedResult;
  const unique = new Map<string, DiscoveredThread>();
  for (const thread of threadResult) if (!unique.has(thread.id)) unique.set(thread.id, { ...thread, loaded: false });
  return [...unique.values()].map((thread) => ({ ...thread, loaded: loaded.has(thread.id) }));
}

export function formatThread(thread: DiscoveredThread, index: number): string {
  const title = thread.name ?? thread.preview.split(/\r?\n/u, 1)[0] ?? "Untitled";
  const status = thread.status.type === "active"
    ? `active:${thread.status.activeFlags.join(",") || "working"}`
    : thread.status.type;
  return `${index + 1}. ${title.slice(0, 70)} [${status}${thread.loaded ? ", loaded" : ""}] ${thread.cwd}`;
}
