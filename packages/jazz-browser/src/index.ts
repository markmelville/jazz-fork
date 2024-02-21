import {
    AccountMigration,
    BinaryCoStream,
    CoValue,
    InviteSecret,
} from "cojson";
import { BinaryCoStreamMeta } from "cojson";
import { MAX_RECOMMENDED_TX_SIZE } from "cojson";
import { cojsonReady } from "cojson";
import {
    LocalNode,
    cojsonInternals,
    AccountID,
    AgentID,
    SessionID,
    SyncMessage,
    Peer,
    Group,
    CoID,
} from "cojson";
import {
    LSMStorage,
    FileSystem,
    FSErr,
    BlockFilename,
} from "cojson-storage-lsm";
import { Effect } from "effect";
import { ReadableStream, WritableStream } from "isomorphic-streams";
import { Resolved } from "jazz-autosub";

export * from "jazz-autosub";
export { BrowserDemoAuth } from "./DemoAuth";
export type { BrowserDemoAuthDriver } from "./DemoAuth";

export type BrowserNodeHandle = {
    node: LocalNode;
    // TODO: Symbol.dispose?
    done: () => void;
};

export async function createBrowserNode({
    auth,
    syncAddress = "wss://sync.jazz.tools",
    reconnectionTimeout: initialReconnectionTimeout = 500,
    migration,
}: {
    auth: AuthProvider;
    syncAddress?: string;
    reconnectionTimeout?: number;
    migration?: AccountMigration;
}): Promise<BrowserNodeHandle> {
    await cojsonReady;
    let sessionDone: () => void;

    const firstWsPeer = createWebSocketPeer(syncAddress);
    let shouldTryToReconnect = true;

    let currentReconnectionTimeout = initialReconnectionTimeout;

    function onOnline() {
        console.log("Online, resetting reconnection timeout");
        currentReconnectionTimeout = initialReconnectionTimeout;
    }

    window.addEventListener("online", onOnline);


    const opfsWorkerJSSrc = `

    let rootDirHandle;
    const handlesByRequest = new Map();
    const handlesByFilename = new Map();

    onmessage = async (event) => {
        rootDirHandle = rootDirHandle || await navigator.storage.getDirectory();
        console.log("Received in OPFS worker", {...event.data, data: event.data.data ? "some data of length " + event.data.data.length : undefined});
        if (event.data.type === "listFiles") {
            const fileNames = [];
            for await (const entry of rootDirHandle.values()) {
                if (entry.kind === "file") {
                    fileNames.push(entry.name);
                }
            }
            postMessage({requestId: event.data.requestId, fileNames});
        } else if (event.data.type === "openToRead" || event.data.type === "openToWrite") {
            let syncHandle;
            const existingHandle = handlesByFilename.get(event.data.filename);
            if (existingHandle) {
                syncHandle = existingHandle;
            } else {
                const handle = await rootDirHandle.getFileHandle(event.data.filename);
                syncHandle = await handle.createSyncAccessHandle();
            }
            handlesByRequest.set(event.data.requestId, syncHandle);
            handlesByFilename.set(event.data.filename, syncHandle);
            postMessage({requestId: event.data.requestId, handle: event.data.requestId, size: syncHandle.getSize()});
        } else if (event.data.type === "createFile") {
            const handle = await rootDirHandle.getFileHandle(event.data.filename, {
                create: true,
            });
            const syncHandle = await handle.createSyncAccessHandle();
            handlesByRequest.set(event.data.requestId, syncHandle);
            handlesByFilename.set(event.data.filename, syncHandle);
            postMessage({requestId: event.data.requestId, handle: event.data.requestId, result: "done"});
        } else if (event.data.type === "append") {
            const writable = handlesByRequest.get(event.data.handle);
            writable.write(event.data.data, {at: writable.getSize()});
            writable.flush();
            postMessage({requestId: event.data.requestId, result: "done"});
        } else if (event.data.type === "read") {
            const readable = handlesByRequest.get(event.data.handle);
            const buffer = new Uint8Array(event.data.length);
            const read = readable.read(buffer, {at: event.data.offset});
            if (read < event.data.length) {
                throw new Error("Couldn't read enough");
            }
            postMessage({requestId: event.data.requestId, data: buffer, result: "done"});
        } else if (event.data.type === "renameAndClose") {
            const handle = handlesByRequest.get(event.data.handle);
            const newHandle = await rootDirHandle.getFileHandle(event.data.filename, { create: true });
            const writable = await newHandle.createSyncAccessHandle();
            writable.write(handle.read(new Uint8Array(handle.getSize())));
            writable.flush();
            writable.close();
            postMessage({requestId: event.data.requestId, result: "done"});
        } else {
            console.error("Unknown event type", event.data.type);
        }
    };

    //# sourceURL=opfsWorker.js
    `;

    const opfsWorker = new Worker(
        URL.createObjectURL(new Blob([opfsWorkerJSSrc], { type: "text/javascript" }))
    );

    class OPFSFilesystem
        implements FileSystem<number, number>
    {
        opfsWorker: Worker;
        callbacks: Map<number, (event: MessageEvent) => void> = new Map();
        nextRequestId = 0;

        constructor(opfsWorker: Worker) {
            this.opfsWorker = opfsWorker;
            opfsWorker.onmessage = (event) => {
                // console.log("Received from OPFS worker", event.data);
                const handler = this.callbacks.get(event.data.requestId);
                if (handler) {
                    handler(event);
                    this.callbacks.delete(event.data.requestId);
                }
            }
        }

        listFiles(): Effect.Effect<string[], FSErr, never> {
            return Effect.async((cb) => {
                const requestId = this.nextRequestId++;
                this.callbacks.set(requestId, (event) => {
                    cb(Effect.succeed(event.data.fileNames));
                });
                this.opfsWorker.postMessage({type: "listFiles", requestId});
            });
        }

        openToRead(
            filename: string
        ): Effect.Effect<
            { handle: number; size: number },
            FSErr,
            never
        > {
            return Effect.async((cb) => {
                const requestId = this.nextRequestId++;
                this.callbacks.set(requestId, (event) => {
                    cb(
                        Effect.succeed({
                            handle: event.data.handle,
                            size: event.data.size,
                        })
                    );
                });
                this.opfsWorker.postMessage({
                    type: "openToRead",
                    filename,
                    requestId,
                });
            });
        }

        createFile(
            filename: string
        ): Effect.Effect<number, FSErr, never> {
            return Effect.async((cb) => {
                const requestId = this.nextRequestId++;
                this.callbacks.set(requestId, (event) => {
                    cb(Effect.succeed(event.data.handle));
                });
                this.opfsWorker.postMessage({
                    type: "createFile",
                    filename,
                    requestId,
                });
            });
        }

        openToWrite(
            filename: string
        ): Effect.Effect<FileSystemFileHandle, FSErr, never> {
            return Effect.async((cb) => {
                const requestId = this.nextRequestId++;
                this.callbacks.set(requestId, (event) => {
                    cb(Effect.succeed(event.data.handle));
                });
                this.opfsWorker.postMessage({
                    type: "openToWrite",
                    filename,
                    requestId,
                });
            });
        }

        append(
            handle: number,
            data: Uint8Array
        ): Effect.Effect<void, FSErr, never> {
            return Effect.async((cb) => {
                const requestId = this.nextRequestId++;
                this.callbacks.set(requestId, (_) => {
                    cb(Effect.succeed(undefined));
                });
                this.opfsWorker.postMessage({
                    type: "append",
                    handle,
                    data,
                    requestId,
                });
            });
        }

        read(
            handle: number,
            offset: number,
            length: number
        ): Effect.Effect<Uint8Array, FSErr, never> {
            return Effect.async((cb) => {
                const requestId = this.nextRequestId++;
                this.callbacks.set(requestId, (event) => {
                    cb(Effect.succeed(event.data.data));
                });
                this.opfsWorker.postMessage({
                    type: "read",
                    handle,
                    offset,
                    length,
                    requestId,
                });
            });
        }

        renameAndClose(
            handle: number,
            filename: BlockFilename
        ): Effect.Effect<void, FSErr, never> {
            return Effect.async((cb) => {
                const requestId = this.nextRequestId++;
                this.callbacks.set(requestId, () => {
                    cb(Effect.succeed(undefined));
                });
                this.opfsWorker.postMessage({
                    type: "renameAndClose",
                    handle,
                    filename,
                    requestId,
                });
            });
        }
    }

    const node = await auth.createNode(
        (accountID) => {
            const sessionHandle = getSessionHandleFor(accountID);
            sessionDone = sessionHandle.done;
            return sessionHandle.session;
        },
        [
            await LSMStorage.asPeer({
                fs: new OPFSFilesystem(opfsWorker),
                trace: true,
            }),
            firstWsPeer,
        ],
        migration
    );

    async function websocketReconnectLoop() {
        while (shouldTryToReconnect) {
            if (
                Object.keys(node.syncManager.peers).some((peerId) =>
                    peerId.includes(syncAddress)
                )
            ) {
                // TODO: this might drain battery, use listeners instead
                await new Promise((resolve) => setTimeout(resolve, 100));
            } else {
                console.log(
                    "Websocket disconnected, trying to reconnect in " +
                        currentReconnectionTimeout +
                        "ms"
                );
                currentReconnectionTimeout = Math.min(
                    currentReconnectionTimeout * 2,
                    30000
                );
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, currentReconnectionTimeout);
                    window.addEventListener(
                        "online",
                        () => {
                            console.log(
                                "Online, trying to reconnect immediately"
                            );
                            resolve();
                        },
                        { once: true }
                    );
                });

                node.syncManager.addPeer(createWebSocketPeer(syncAddress));
            }
        }
    }

    void websocketReconnectLoop();

    return {
        node,
        done: () => {
            shouldTryToReconnect = false;
            window.removeEventListener("online", onOnline);
            console.log("Cleaning up node");
            for (const peer of Object.values(node.syncManager.peers)) {
                peer.outgoing
                    .close()
                    .catch((e) => console.error("Error while closing peer", e));
            }
            sessionDone?.();
        },
    };
}

export interface AuthProvider {
    createNode(
        getSessionFor: SessionProvider,
        initialPeers: Peer[],
        migration?: AccountMigration
    ): Promise<LocalNode>;
}

export type SessionProvider = (
    accountID: AccountID | AgentID
) => Promise<SessionID>;

export type SessionHandle = {
    session: Promise<SessionID>;
    done: () => void;
};

function getSessionHandleFor(accountID: AccountID | AgentID): SessionHandle {
    let done!: () => void;
    const donePromise = new Promise<void>((resolve) => {
        done = resolve;
    });

    let resolveSession: (sessionID: SessionID) => void;
    const sessionPromise = new Promise<SessionID>((resolve) => {
        resolveSession = resolve;
    });

    void (async function () {
        for (let idx = 0; idx < 100; idx++) {
            // To work better around StrictMode
            for (let retry = 0; retry < 2; retry++) {
                console.debug("Trying to get lock", accountID + "_" + idx);
                const sessionFinishedOrNoLock = await navigator.locks.request(
                    accountID + "_" + idx,
                    { ifAvailable: true },
                    async (lock) => {
                        if (!lock) return "noLock";

                        const sessionID =
                            localStorage[accountID + "_" + idx] ||
                            cojsonInternals.newRandomSessionID(accountID);
                        localStorage[accountID + "_" + idx] = sessionID;

                        console.debug(
                            "Got lock",
                            accountID + "_" + idx,
                            sessionID
                        );

                        resolveSession(sessionID);

                        await donePromise;
                        console.log(
                            "Done with lock",
                            accountID + "_" + idx,
                            sessionID
                        );
                        return "sessionFinished";
                    }
                );

                if (sessionFinishedOrNoLock === "sessionFinished") {
                    return;
                }
            }
        }
        throw new Error("Couldn't get lock on session after 100x2 tries");
    })();

    return {
        session: sessionPromise,
        done,
    };
}

function websocketReadableStream<T>(ws: WebSocket) {
    ws.binaryType = "arraybuffer";

    return new ReadableStream<T>({
        start(controller) {
            let pingTimeout: ReturnType<typeof setTimeout> | undefined;

            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);

                if (pingTimeout) {
                    clearTimeout(pingTimeout);
                }

                pingTimeout = setTimeout(() => {
                    console.debug("Ping timeout");
                    try {
                        controller.close();
                        ws.close();
                    } catch (e) {
                        console.error(
                            "Error while trying to close ws on ping timeout",
                            e
                        );
                    }
                }, 2500);

                if (msg.type === "ping") {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (window as any).jazzPings = (window as any).jazzPings || [];
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (window as any).jazzPings.push({
                        received: Date.now(),
                        sent: msg.time,
                        dc: msg.dc,
                    });
                    return;
                }
                controller.enqueue(msg);
            };
            const closeListener = () => {
                controller.close();
                clearTimeout(pingTimeout);
            };
            ws.addEventListener("close", closeListener);
            ws.addEventListener("error", () => {
                controller.error(new Error("The WebSocket errored!"));
                ws.removeEventListener("close", closeListener);
            });
        },

        cancel() {
            ws.close();
        },
    });
}

function createWebSocketPeer(syncAddress: string): Peer {
    const ws = new WebSocket(syncAddress);

    const incoming = websocketReadableStream<SyncMessage>(ws);
    const outgoing = websocketWritableStream<SyncMessage>(ws);

    return {
        id: syncAddress + "@" + new Date().toISOString(),
        incoming,
        outgoing,
        role: "server",
    };
}

function websocketWritableStream<T>(ws: WebSocket) {
    const initialQueue = [] as T[];
    let isOpen = false;

    return new WritableStream<T>({
        start(controller) {
            ws.addEventListener("error", (event) => {
                controller.error(
                    new Error("The WebSocket errored!" + JSON.stringify(event))
                );
            });
            ws.addEventListener("close", () => {
                controller.error(
                    new Error("The server closed the connection unexpectedly!")
                );
            });
            ws.addEventListener("open", () => {
                for (const item of initialQueue) {
                    ws.send(JSON.stringify(item));
                }
                isOpen = true;
            });
        },

        async write(chunk) {
            if (isOpen) {
                ws.send(JSON.stringify(chunk));
                // Return immediately, since the web socket gives us no easy way to tell
                // when the write completes.
            } else {
                initialQueue.push(chunk);
            }
        },

        close() {
            return closeWS(1000);
        },

        abort(reason) {
            return closeWS(4000, reason && reason.message);
        },
    });

    function closeWS(code: number, reasonString?: string) {
        return new Promise<void>((resolve, reject) => {
            ws.addEventListener(
                "close",
                (e) => {
                    if (e.wasClean) {
                        resolve();
                    } else {
                        reject(
                            new Error("The connection was not closed cleanly")
                        );
                    }
                },
                { once: true }
            );
            ws.close(code, reasonString);
        });
    }
}

export function createInviteLink<C extends CoValue>(
    value: C | Resolved<C>,
    role: "reader" | "writer" | "admin",
    // default to same address as window.location, but without hash
    {
        baseURL = window.location.href.replace(/#.*$/, ""),
        valueHint,
    }: { baseURL?: string; valueHint?: string } = {}
): string {
    const coValueCore =
        "coValueType" in value ? value.meta.coValue.core : value.core;
    let currentCoValue = coValueCore;

    while (currentCoValue.header.ruleset.type === "ownedByGroup") {
        currentCoValue = currentCoValue.getGroup().core;
    }

    if (currentCoValue.header.ruleset.type !== "group") {
        throw new Error("Can't create invite link for object without group");
    }

    const group = cojsonInternals.expectGroup(
        currentCoValue.getCurrentContent()
    );
    const inviteSecret = group.createInvite(role);

    return `${baseURL}#/invite/${valueHint ? valueHint + "/" : ""}${
        value.id
    }/${inviteSecret}`;
}

export function parseInviteLink<C extends CoValue>(
    inviteURL: string
):
    | {
          valueID: CoID<C>;
          valueHint?: string;
          inviteSecret: InviteSecret;
      }
    | undefined {
    const url = new URL(inviteURL);
    const parts = url.hash.split("/");

    let valueHint: string | undefined;
    let valueID: CoID<C> | undefined;
    let inviteSecret: InviteSecret | undefined;

    if (parts[0] === "#" && parts[1] === "invite") {
        if (parts.length === 5) {
            valueHint = parts[2];
            valueID = parts[3] as CoID<C>;
            inviteSecret = parts[4] as InviteSecret;
        } else if (parts.length === 4) {
            valueID = parts[2] as CoID<C>;
            inviteSecret = parts[3] as InviteSecret;
        }

        if (!valueID || !inviteSecret) {
            return undefined;
        }
        return { valueID, inviteSecret, valueHint };
    }
}

export function consumeInviteLinkFromWindowLocation<C extends CoValue>(
    node: LocalNode
): Promise<
    | {
          valueID: CoID<C>;
          inviteSecret: string;
      }
    | undefined
> {
    return new Promise((resolve, reject) => {
        const result = parseInviteLink<C>(window.location.href);

        if (result) {
            node.acceptInvite(result.valueID, result.inviteSecret)
                .then(() => {
                    resolve(result);
                    window.history.replaceState(
                        {},
                        "",
                        window.location.href.replace(/#.*$/, "")
                    );
                })
                .catch(reject);
        } else {
            resolve(undefined);
        }
    });
}

export async function createBinaryStreamFromBlob<
    C extends BinaryCoStream<BinaryCoStreamMeta>,
>(
    blob: Blob | File,
    inGroup: Group | Resolved<Group>,
    meta: C["headerMeta"] = { type: "binary" },
    onProgress?: (progress: number) => void
): Promise<C> {
    let stream = inGroup.createBinaryStream(meta);

    const start = Date.now();

    const reader = new FileReader();
    const done = new Promise<void>((resolve) => {
        reader.onload = async () => {
            const data = new Uint8Array(reader.result as ArrayBuffer);
            stream.startBinaryStream({
                mimeType: blob.type,
                totalSizeBytes: blob.size,
                fileName: blob instanceof File ? blob.name : undefined,
            });
            const chunkSize = MAX_RECOMMENDED_TX_SIZE;

            let lastProgressUpdate = Date.now();

            for (let idx = 0; idx < data.length; idx += chunkSize) {
                stream.pushBinaryStreamChunk(data.slice(idx, idx + chunkSize));

                if (Date.now() - lastProgressUpdate > 100) {
                    onProgress?.(idx / data.length);
                    lastProgressUpdate = Date.now();
                }

                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            stream = stream.endBinaryStream();
            const end = Date.now();

            console.debug(
                "Finished creating binary stream in",
                (end - start) / 1000,
                "s - Throughput in MB/s",
                (1000 * (blob.size / (end - start))) / (1024 * 1024)
            );
            onProgress?.(1);
            resolve();
        };
    });
    setTimeout(() => {
        reader.readAsArrayBuffer(blob);
    });

    await done;

    return stream;
}

export async function readBlobFromBinaryStream<
    C extends BinaryCoStream<BinaryCoStreamMeta>,
>(
    streamId: CoID<C>,
    node: LocalNode,
    allowUnfinished?: boolean,
    onProgress?: (progress: number) => void
): Promise<Blob | undefined> {
    const stream = await node.load<C>(streamId, onProgress);

    if (stream === "unavailable") {
        return undefined;
    }

    const chunks = stream.getBinaryChunks(allowUnfinished);

    if (!chunks) {
        return undefined;
    }

    return new Blob(chunks.chunks, { type: chunks.mimeType });
}
