import * as net from "node:net";
import { EventEmitter } from "node:events";
import {
  HANDSHAKE,
  FLAGS_REPLY,
  CommandSet,
  VMCommand,
  ReferenceTypeCommand,
  MethodCommand,
  ThreadCommand,
  StackFrameCommand,
  EventRequestCommand,
  StringReferenceCommand,
  ObjectReferenceCommand,
  ArrayReferenceCommand,
  EventKind,
  SuspendPolicy,
  StepSize,
  StepDepth,
  ModKind,
  TypeTag,
  Tag,
} from "./constants.js";
import {
  type IDSizes,
  type ReplyPacket,
  JDWPWriter,
  JDWPReader,
  buildCommandPacket,
  hasCompletePacket,
  getPacketLength,
  isReplyPacket,
} from "./protocol.js";

export type BreakpointSuspendPolicy = "all" | "thread";

export interface BreakpointInfo {
  requestId: number;
  className: string;
  line: number;
  suspendPolicy: BreakpointSuspendPolicy;
  classId?: bigint;
  methodId?: bigint;
}

export interface ThreadInfo {
  id: bigint;
  name: string;
  status: number;
  suspendStatus: number;
}

export interface FrameInfo {
  frameId: bigint;
  location: {
    typeTag: number;
    classID: bigint;
    methodID: bigint;
    index: bigint;
  };
  className?: string;
  methodName?: string;
  lineNumber?: number;
}

export interface VariableInfo {
  name: string;
  signature: string;
  slot: number;
  tag: number;
  value: unknown;
  stringValue?: string;
}

interface PendingRequest {
  resolve: (reply: ReplyPacket) => void;
  reject: (err: Error) => void;
}

/**
 * Event kinds that should NOT trigger an automatic VM resume.
 * When the JVM sends these events with a suspend policy, the VM stays suspended
 * so the user (or AI assistant) can inspect state and set breakpoints before resuming.
 */
const SUSPEND_PRESERVING_EVENTS: ReadonlySet<number> = new Set([
  EventKind.Breakpoint,
  EventKind.SingleStep,
  EventKind.VMStart,
  EventKind.ClassPrepare, // Keep VM suspended so breakpoints can be set before execution continues
]);

export class JDWPClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private connected = false;
  private handshakeComplete = false;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private receiveBuffer = Buffer.alloc(0);
  private idSizes: IDSizes = {
    fieldIDSize: 8,
    methodIDSize: 8,
    objectIDSize: 8,
    referenceTypeIDSize: 8,
    frameIDSize: 8,
  };
  private breakpoints = new Map<number, BreakpointInfo>();
  private classPrepareRequests = new Map<
    string,
    { resolve: (classId: bigint) => void; requestId: number }
  >();
  // Consolidated thread/VM suspend state
  private threadState = {
    /** Threads currently suspended by breakpoints/steps */
    suspended: new Set<bigint>(),
    /** Most recently suspended thread (convenience default) */
    lastSuspendedId: null as bigint | null,
    /** Whether the entire VM is suspended (e.g. from suspend=y launch) */
    vmSuspended: false,
  };

  get isConnected(): boolean {
    return this.connected && this.handshakeComplete;
  }

  /** Whether the entire VM is currently suspended (e.g. from suspend=y launch) */
  get vmSuspended(): boolean {
    return this.threadState.vmSuspended;
  }

  /** The most recently suspended thread (from breakpoint or step) */
  get currentThreadId(): bigint | null {
    return this.threadState.lastSuspendedId;
  }

  /** All threads currently known to be suspended by breakpoints/steps */
  get allSuspendedThreadIds(): bigint[] {
    return Array.from(this.threadState.suspended);
  }

  // --- Thread state mutation helpers ---

  private markThreadSuspended(threadId: bigint): void {
    this.threadState.suspended.add(threadId);
    this.threadState.lastSuspendedId = threadId;
  }

  private markThreadResumed(threadId: bigint): void {
    this.threadState.suspended.delete(threadId);
    if (this.threadState.lastSuspendedId === threadId) {
      const remaining = this.allSuspendedThreadIds;
      this.threadState.lastSuspendedId =
        remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
  }

  private markAllResumed(): void {
    this.threadState.suspended.clear();
    this.threadState.lastSuspendedId = null;
    this.threadState.vmSuspended = false;
  }

  private resetThreadState(): void {
    this.threadState.suspended.clear();
    this.threadState.lastSuspendedId = null;
    this.threadState.vmSuspended = false;
  }

  async connect(host: string, port: number): Promise<string> {
    return await new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host, port, autoSelectFamily: true }, () => {
        // Disable Nagle's algorithm for low-latency JDWP communication
        this.socket?.setNoDelay(true);
        this.socket?.setKeepAlive(true, 30000);
        // Send handshake
        this.socket?.write(HANDSHAKE);
      });

      let handshakeBuffer = Buffer.alloc(0);

      const onData = (data: Buffer) => {
        if (!this.handshakeComplete) {
          handshakeBuffer = Buffer.concat([handshakeBuffer, data]);
          if (handshakeBuffer.length >= HANDSHAKE.length) {
            const response = handshakeBuffer.subarray(0, HANDSHAKE.length).toString();
            if (response === HANDSHAKE) {
              this.handshakeComplete = true;
              this.connected = true;
              // Process any remaining data after handshake
              this.receiveBuffer = handshakeBuffer.subarray(HANDSHAKE.length);
              this.socket?.removeListener("data", onData);
              this.socket?.on("data", (d: Buffer) => this.onData(d));
              this.processBuffer();
              // Get ID sizes and version
              this.initialize().then(
                (version) => resolve(version),
                (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
              );
            } else {
              reject(new Error("Invalid JDWP handshake response"));
            }
          }
        }
      };

      this.socket.on("data", onData);
      this.socket.on("error", (err) => {
        this.connected = false;
        if (!this.handshakeComplete) {
          reject(err);
        }
        this.emit("error", err);
      });
      this.socket.on("close", () => {
        this.connected = false;
        this.handshakeComplete = false;
        this.emit("close");
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      // Send dispose command
      try {
        await this.sendCommand(CommandSet.VirtualMachine, VMCommand.Dispose);
      } catch {
        // Ignore errors during disconnect
      }
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
      this.handshakeComplete = false;
      this.breakpoints.clear();
      this.resetThreadState();
    }
  }

  private async initialize(): Promise<string> {
    // Get ID sizes first - critical for all subsequent communication
    const idReply = await this.sendCommand(CommandSet.VirtualMachine, VMCommand.IDSizes);
    const idReader = new JDWPReader(idReply.data);
    this.idSizes = {
      fieldIDSize: idReader.readInt(),
      methodIDSize: idReader.readInt(),
      objectIDSize: idReader.readInt(),
      referenceTypeIDSize: idReader.readInt(),
      frameIDSize: idReader.readInt(),
    };

    // Get version info
    const verReply = await this.sendCommand(CommandSet.VirtualMachine, VMCommand.Version);
    const verReader = new JDWPReader(verReply.data, this.idSizes);
    verReader.readString(); // description
    verReader.readInt(); // jdwpMajor
    verReader.readInt(); // jdwpMinor
    const vmVersion = verReader.readString();
    const vmName = verReader.readString();

    return `${vmName} ${vmVersion}`;
  }

  private onData(data: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (hasCompletePacket(this.receiveBuffer)) {
      const length = getPacketLength(this.receiveBuffer);
      const packet = this.receiveBuffer.subarray(0, length);
      this.receiveBuffer = this.receiveBuffer.subarray(length);

      if (isReplyPacket(packet)) {
        // Reply packet
        const id = packet.readInt32BE(4);
        const errorCode = packet.readUInt16BE(9);
        const data = packet.subarray(11);
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          pending.resolve({ id, flags: FLAGS_REPLY, errorCode, data });
        }
      } else {
        // Event/command packet from VM
        this.handleEvent(packet);
      }
    }
  }

  private handleEvent(packet: Buffer): void {
    const commandSet = packet.readUInt8(9);
    const command = packet.readUInt8(10);
    const data = packet.subarray(11);

    if (commandSet === CommandSet.Event && command === 100) {
      // Composite event
      const reader = new JDWPReader(data, this.idSizes);
      const suspendPolicy = reader.readByte();
      const eventCount = reader.readInt();
      const observedEventKinds: number[] = [];

      for (let i = 0; i < eventCount; i++) {
        const eventKind = reader.readByte();
        observedEventKinds.push(eventKind);

        switch (eventKind) {
          case EventKind.VMStart: {
            const requestId = reader.readInt();
            const threadId = reader.readThreadID();
            this.emit("vmstart", { requestId, threadId });
            break;
          }
          case EventKind.VMDeath: {
            const requestId = reader.readInt();
            this.emit("vmdeath", { requestId });
            break;
          }
          case EventKind.Breakpoint: {
            const requestId = reader.readInt();
            const threadId = reader.readThreadID();
            const location = reader.readLocation();
            this.markThreadSuspended(threadId);
            this.emit("breakpoint", { requestId, threadId, location });
            break;
          }
          case EventKind.SingleStep: {
            const requestId = reader.readInt();
            const threadId = reader.readThreadID();
            const location = reader.readLocation();
            this.markThreadSuspended(threadId);
            // Auto-clear single step request
            this.clearEventRequest(EventKind.SingleStep, requestId).catch(() => {});
            this.emit("step", { requestId, threadId, location });
            break;
          }
          case EventKind.ClassPrepare: {
            const requestId = reader.readInt();
            const threadId = reader.readThreadID();
            const refTypeTag = reader.readByte();
            const typeID = reader.readReferenceTypeID();
            const signature = reader.readString();
            const status = reader.readInt();
            this.emit("classprepare", {
              requestId,
              threadId,
              refTypeTag,
              typeID,
              signature,
              status,
            });

            // Check if we're waiting for this class
            const className = jniSignatureToClassName(signature);
            const waiting = this.classPrepareRequests.get(className);
            if (waiting) {
              this.classPrepareRequests.delete(className);
              // Clear the class prepare request
              this.clearEventRequest(EventKind.ClassPrepare, waiting.requestId).catch(() => {});
              waiting.resolve(typeID);
            }
            break;
          }
          case EventKind.ThreadStart: {
            const requestId = reader.readInt();
            const threadId = reader.readThreadID();
            this.emit("threadstart", { requestId, threadId });
            break;
          }
          case EventKind.ThreadDeath: {
            const requestId = reader.readInt();
            const threadId = reader.readThreadID();
            this.emit("threaddeath", { requestId, threadId });
            break;
          }
          default: {
            // Skip unknown events - try to read requestId at minimum
            try {
              reader.readInt();
            } catch {
              // ignore
            }
            break;
          }
        }
      }

      // Auto-resume logic: if the VM was suspended by this event, decide whether to keep it
      // suspended or auto-resume. Events in SUSPEND_PRESERVING_EVENTS (breakpoints, steps,
      // VMStart) keep the VM suspended so the user can inspect state / set breakpoints.
      // Internal events (ClassPrepare, ThreadStart, etc.) are auto-resumed.
      if (suspendPolicy === SuspendPolicy.All || suspendPolicy === SuspendPolicy.EventThread) {
        const shouldPreserveSuspend = observedEventKinds.some((kind) =>
          SUSPEND_PRESERVING_EVENTS.has(kind),
        );

        if (shouldPreserveSuspend) {
          // Only mark VM-wide suspend when SuspendPolicy.All is used (e.g. VMStart with suspend=y).
          // SuspendPolicy.EventThread (default for breakpoints/steps) only suspends one thread,
          // so the VM as a whole is not suspended.
          if (suspendPolicy === SuspendPolicy.All) {
            this.threadState.vmSuspended = true;
          }
        } else {
          this.resumeVM().catch(() => {});
        }
      }
    }
  }

  private sendCommand(commandSet: number, command: number, data?: Buffer): Promise<ReplyPacket> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error("Not connected to JVM"));
        return;
      }

      const id = this.nextId++;
      const packet = buildCommandPacket(id, commandSet, command, data);

      this.pendingRequests.set(id, { resolve, reject });
      this.socket.write(packet);

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Command timeout: cmdSet=${commandSet}, cmd=${command}`));
        }
      }, 10000);
    });
  }

  private checkError(reply: ReplyPacket): void {
    if (reply.errorCode !== 0) {
      throw new Error(`JDWP error: ${reply.errorCode}`);
    }
  }

  /**
   * High-level helper: build request data, send command, check error, parse reply.
   * Eliminates the repeated Writer→sendCommand→checkError→Reader boilerplate.
   */
  private async sendRequest<T>(
    commandSet: number,
    command: number,
    writeData: ((writer: JDWPWriter) => void) | null,
    readReply: (reader: JDWPReader) => T,
  ): Promise<T> {
    let data: Buffer | undefined;
    if (writeData) {
      const writer = new JDWPWriter(this.idSizes);
      writeData(writer);
      data = writer.toBuffer();
    }
    const reply = await this.sendCommand(commandSet, command, data);
    this.checkError(reply);
    const reader = new JDWPReader(reply.data, this.idSizes);
    return readReply(reader);
  }

  // === High-level API ===

  async getVersion(): Promise<string> {
    return this.sendRequest(CommandSet.VirtualMachine, VMCommand.Version, null, (r) => {
      r.readString(); // description
      r.readInt(); // jdwpMajor
      r.readInt(); // jdwpMinor
      const vmVersion = r.readString();
      const vmName = r.readString();
      return `${vmName} ${vmVersion}`;
    });
  }

  async suspendVM(): Promise<void> {
    const reply = await this.sendCommand(CommandSet.VirtualMachine, VMCommand.Suspend);
    this.checkError(reply);
    this.threadState.vmSuspended = true;
  }

  async resumeVM(): Promise<void> {
    const reply = await this.sendCommand(CommandSet.VirtualMachine, VMCommand.Resume);
    this.checkError(reply);
    this.markAllResumed();
  }

  async getClassesBySignature(
    signature: string,
  ): Promise<Array<{ refTypeTag: number; typeID: bigint; status: number }>> {
    return this.sendRequest(
      CommandSet.VirtualMachine,
      VMCommand.ClassesBySignature,
      (w) => w.writeString(signature),
      (r) => {
        const count = r.readInt();
        const classes = [];
        for (let i = 0; i < count; i++) {
          classes.push({
            refTypeTag: r.readByte(),
            typeID: r.readReferenceTypeID(),
            status: r.readInt(),
          });
        }
        return classes;
      },
    );
  }

  async getReferenceTypeSignature(refTypeId: bigint): Promise<string> {
    return this.sendRequest(
      CommandSet.ReferenceType,
      ReferenceTypeCommand.Signature,
      (w) => w.writeReferenceTypeID(refTypeId),
      (r) => r.readString(),
    );
  }

  async getSourceFile(refTypeId: bigint): Promise<string> {
    return this.sendRequest(
      CommandSet.ReferenceType,
      ReferenceTypeCommand.SourceFile,
      (w) => w.writeReferenceTypeID(refTypeId),
      (r) => r.readString(),
    );
  }

  async getMethods(
    refTypeId: bigint,
  ): Promise<Array<{ methodID: bigint; name: string; signature: string; modBits: number }>> {
    return this.sendRequest(
      CommandSet.ReferenceType,
      ReferenceTypeCommand.Methods,
      (w) => w.writeReferenceTypeID(refTypeId),
      (r) => {
        const count = r.readInt();
        const methods = [];
        for (let i = 0; i < count; i++) {
          methods.push({
            methodID: r.readMethodID(),
            name: r.readString(),
            signature: r.readString(),
            modBits: r.readInt(),
          });
        }
        return methods;
      },
    );
  }

  async getFields(
    refTypeId: bigint,
  ): Promise<Array<{ fieldID: bigint; name: string; signature: string; modBits: number }>> {
    return this.sendRequest(
      CommandSet.ReferenceType,
      ReferenceTypeCommand.Fields,
      (w) => w.writeReferenceTypeID(refTypeId),
      (r) => {
        const count = r.readInt();
        const fields = [];
        for (let i = 0; i < count; i++) {
          fields.push({
            fieldID: r.readFieldID(),
            name: r.readString(),
            signature: r.readString(),
            modBits: r.readInt(),
          });
        }
        return fields;
      },
    );
  }

  async getLineTable(
    refTypeId: bigint,
    methodId: bigint,
  ): Promise<{
    start: bigint;
    end: bigint;
    lines: Array<{ lineCodeIndex: bigint; lineNumber: number }>;
  }> {
    return this.sendRequest(
      CommandSet.Method,
      MethodCommand.LineTable,
      (w) => {
        w.writeReferenceTypeID(refTypeId);
        w.writeMethodID(methodId);
      },
      (r) => {
        const start = r.readLong();
        const end = r.readLong();
        const lineCount = r.readInt();
        const lines = [];
        for (let i = 0; i < lineCount; i++) {
          lines.push({
            lineCodeIndex: r.readLong(),
            lineNumber: r.readInt(),
          });
        }
        return { start, end, lines };
      },
    );
  }

  async getVariableTable(
    refTypeId: bigint,
    methodId: bigint,
  ): Promise<
    Array<{
      codeIndex: bigint;
      name: string;
      signature: string;
      length: number;
      slot: number;
    }>
  > {
    return this.sendRequest(
      CommandSet.Method,
      MethodCommand.VariableTable,
      (w) => {
        w.writeReferenceTypeID(refTypeId);
        w.writeMethodID(methodId);
      },
      (r) => {
        r.readInt(); // argCnt
        const count = r.readInt();
        const variables = [];
        for (let i = 0; i < count; i++) {
          variables.push({
            codeIndex: r.readLong(),
            name: r.readString(),
            signature: r.readString(),
            length: r.readInt(),
            slot: r.readInt(),
          });
        }
        return variables;
      },
    );
  }

  // === Thread operations ===

  async getAllThreads(): Promise<ThreadInfo[]> {
    const threadIds = await this.sendRequest(
      CommandSet.VirtualMachine,
      VMCommand.AllThreads,
      null,
      (r) => {
        const count = r.readInt();
        const ids: bigint[] = [];
        for (let i = 0; i < count; i++) ids.push(r.readThreadID());
        return ids;
      },
    );

    const threads: ThreadInfo[] = [];
    for (const id of threadIds) {
      try {
        const name = await this.getThreadName(id);
        const statusInfo = await this.getThreadStatus(id);
        threads.push({
          id,
          name,
          status: statusInfo.threadStatus,
          suspendStatus: statusInfo.suspendStatus,
        });
      } catch {
        // Thread may have died
        threads.push({ id, name: "<unknown>", status: 0, suspendStatus: 0 });
      }
    }
    return threads;
  }

  async getThreadName(threadId: bigint): Promise<string> {
    return this.sendRequest(
      CommandSet.ThreadReference,
      ThreadCommand.Name,
      (w) => w.writeThreadID(threadId),
      (r) => r.readString(),
    );
  }

  async getThreadStatus(
    threadId: bigint,
  ): Promise<{ threadStatus: number; suspendStatus: number }> {
    return this.sendRequest(
      CommandSet.ThreadReference,
      ThreadCommand.Status,
      (w) => w.writeThreadID(threadId),
      (r) => ({
        threadStatus: r.readInt(),
        suspendStatus: r.readInt(),
      }),
    );
  }

  async suspendThread(threadId: bigint): Promise<void> {
    const writer = new JDWPWriter(this.idSizes);
    writer.writeThreadID(threadId);
    const reply = await this.sendCommand(
      CommandSet.ThreadReference,
      ThreadCommand.Suspend,
      writer.toBuffer(),
    );
    this.checkError(reply);
    this.markThreadSuspended(threadId);
  }

  async resumeThread(threadId: bigint): Promise<void> {
    const writer = new JDWPWriter(this.idSizes);
    writer.writeThreadID(threadId);
    const reply = await this.sendCommand(
      CommandSet.ThreadReference,
      ThreadCommand.Resume,
      writer.toBuffer(),
    );
    this.checkError(reply);
    this.markThreadResumed(threadId);
  }

  // === Stack frames ===

  async getFrames(
    threadId: bigint,
    startFrame: number = 0,
    maxFrames: number = -1,
  ): Promise<FrameInfo[]> {
    // Always get actual frame count to avoid INVALID_LENGTH errors
    const countWriter = new JDWPWriter(this.idSizes);
    countWriter.writeThreadID(threadId);
    const countReply = await this.sendCommand(
      CommandSet.ThreadReference,
      ThreadCommand.FrameCount,
      countWriter.toBuffer(),
    );
    this.checkError(countReply);
    const countReader = new JDWPReader(countReply.data, this.idSizes);
    const totalFrames = countReader.readInt();

    // Clamp requested frame count to actual available frames
    let length: number;
    if (maxFrames === -1) {
      length = totalFrames - startFrame;
    } else {
      length = Math.min(maxFrames, totalFrames - startFrame);
    }
    if (length <= 0) return [];

    const writer = new JDWPWriter(this.idSizes);
    writer.writeThreadID(threadId);
    writer.writeInt(startFrame);
    writer.writeInt(length);
    const reply = await this.sendCommand(
      CommandSet.ThreadReference,
      ThreadCommand.Frames,
      writer.toBuffer(),
    );
    this.checkError(reply);

    const reader = new JDWPReader(reply.data, this.idSizes);
    const count = reader.readInt();
    const frames: FrameInfo[] = [];

    for (let i = 0; i < count; i++) {
      const frameId = reader.readFrameID();
      const location = reader.readLocation();
      frames.push({ frameId, location });
    }

    // Resolve class/method names and line numbers
    for (const frame of frames) {
      try {
        const sig = await this.getReferenceTypeSignature(frame.location.classID);
        frame.className = jniSignatureToClassName(sig);

        const methods = await this.getMethods(frame.location.classID);
        const method = methods.find((m) => m.methodID === frame.location.methodID);
        if (method) {
          frame.methodName = method.name;
          // Get line number
          try {
            const lineTable = await this.getLineTable(
              frame.location.classID,
              frame.location.methodID,
            );
            let bestLine = -1;
            for (const line of lineTable.lines) {
              if (line.lineCodeIndex <= frame.location.index) {
                bestLine = line.lineNumber;
              }
            }
            if (bestLine !== -1) {
              frame.lineNumber = bestLine;
            }
          } catch {
            // No line info available
          }
        }
      } catch {
        // Can't resolve names
      }
    }

    return frames;
  }

  async getFrameVariables(
    threadId: bigint,
    frameId: bigint,
    location: FrameInfo["location"],
  ): Promise<VariableInfo[]> {
    // Get variable table for the method
    let variables;
    try {
      variables = await this.getVariableTable(location.classID, location.methodID);
    } catch {
      return []; // No variable info (compiled without debug info)
    }

    // Filter variables visible at current code index
    const visibleVars = variables.filter((v) => {
      const codeIndex = location.index;
      return codeIndex >= v.codeIndex && codeIndex < v.codeIndex + BigInt(v.length);
    });

    if (visibleVars.length === 0) return [];

    // Build GetValues request
    const writer = new JDWPWriter(this.idSizes);
    writer.writeThreadID(threadId);
    writer.writeFrameID(frameId);
    writer.writeInt(visibleVars.length);
    for (const v of visibleVars) {
      writer.writeInt(v.slot);
      writer.writeByte(signatureToTag(v.signature));
    }

    const reply = await this.sendCommand(
      CommandSet.StackFrame,
      StackFrameCommand.GetValues,
      writer.toBuffer(),
    );
    this.checkError(reply);

    const reader = new JDWPReader(reply.data, this.idSizes);
    const count = reader.readInt();
    const result: VariableInfo[] = [];

    for (let i = 0; i < count; i++) {
      const tag = reader.readByte();
      const jdwpValue = reader.readUntaggedValue(tag);
      const varInfo = visibleVars[i];

      const info: VariableInfo = {
        name: varInfo.name,
        signature: varInfo.signature,
        slot: varInfo.slot,
        tag,
        value: jdwpValue.value,
      };

      // Resolve string values
      if (tag === Tag.String && jdwpValue.value !== null) {
        try {
          info.stringValue = await this.getStringValue(jdwpValue.value as bigint);
        } catch {
          info.stringValue = "<error reading string>";
        }
      }

      result.push(info);
    }

    return result;
  }

  async getStringValue(objectId: bigint): Promise<string> {
    return this.sendRequest(
      CommandSet.StringReference,
      StringReferenceCommand.Value,
      (w) => w.writeObjectID(objectId),
      (r) => r.readString(),
    );
  }

  async getObjectFields(
    objectId: bigint,
  ): Promise<Array<{ name: string; signature: string; value: string }>> {
    // Get the reference type
    const refWriter = new JDWPWriter(this.idSizes);
    refWriter.writeObjectID(objectId);
    const refReply = await this.sendCommand(
      CommandSet.ObjectReference,
      ObjectReferenceCommand.ReferenceType,
      refWriter.toBuffer(),
    );
    this.checkError(refReply);
    const refReader = new JDWPReader(refReply.data, this.idSizes);
    refReader.readByte(); // refTypeTag
    const refTypeId = refReader.readReferenceTypeID();

    // Get fields
    const fields = await this.getFields(refTypeId);
    if (fields.length === 0) return [];

    // Get field values
    const valWriter = new JDWPWriter(this.idSizes);
    valWriter.writeObjectID(objectId);
    valWriter.writeInt(fields.length);
    for (const f of fields) {
      valWriter.writeFieldID(f.fieldID);
    }
    const valReply = await this.sendCommand(
      CommandSet.ObjectReference,
      ObjectReferenceCommand.GetValues,
      valWriter.toBuffer(),
    );
    this.checkError(valReply);
    const valReader = new JDWPReader(valReply.data, this.idSizes);
    const valCount = valReader.readInt();

    const result: Array<{ name: string; signature: string; value: string }> = [];
    for (let i = 0; i < valCount; i++) {
      const tag = valReader.readByte();
      const jdwpValue = valReader.readUntaggedValue(tag);
      const field = fields[i];

      let valueStr = formatValue(tag, jdwpValue.value);

      // Resolve string values
      if (tag === Tag.String && jdwpValue.value !== null && jdwpValue.value !== 0n) {
        try {
          valueStr = `"${await this.getStringValue(jdwpValue.value as bigint)}"`;
        } catch {
          // keep numeric representation
        }
      }

      result.push({
        name: field.name,
        signature: field.signature,
        value: valueStr,
      });
    }
    return result;
  }

  async getArrayValues(arrayId: bigint, firstIndex: number = 0, length?: number): Promise<string> {
    // Get array length first
    const lenWriter = new JDWPWriter(this.idSizes);
    lenWriter.writeObjectID(arrayId);
    const lenReply = await this.sendCommand(
      CommandSet.ArrayReference,
      ArrayReferenceCommand.Length,
      lenWriter.toBuffer(),
    );
    this.checkError(lenReply);
    const lenReader = new JDWPReader(lenReply.data, this.idSizes);
    const arrayLength = lenReader.readInt();

    const actualLength = length ?? Math.min(arrayLength - firstIndex, 100); // Cap at 100 elements

    if (actualLength <= 0) return `[] (length: ${arrayLength})`;

    const writer = new JDWPWriter(this.idSizes);
    writer.writeObjectID(arrayId);
    writer.writeInt(firstIndex);
    writer.writeInt(actualLength);
    const reply = await this.sendCommand(
      CommandSet.ArrayReference,
      ArrayReferenceCommand.GetValues,
      writer.toBuffer(),
    );
    this.checkError(reply);

    const reader = new JDWPReader(reply.data, this.idSizes);
    const tag = reader.readByte();
    const count = reader.readInt();

    const values: string[] = [];
    const isPrimitive = [
      Tag.Byte,
      Tag.Boolean,
      Tag.Char,
      Tag.Short,
      Tag.Int,
      Tag.Long,
      Tag.Float,
      Tag.Double,
    ].includes(tag);

    for (let i = 0; i < count; i++) {
      if (isPrimitive) {
        const v = reader.readUntaggedValue(tag);
        values.push(formatValue(tag, v.value));
      } else {
        const elemTag = reader.readByte();
        const v = reader.readUntaggedValue(elemTag);
        if (elemTag === Tag.String && v.value !== null && v.value !== 0n) {
          try {
            values.push(`"${await this.getStringValue(v.value as bigint)}"`);
          } catch {
            values.push(formatValue(elemTag, v.value));
          }
        } else {
          values.push(formatValue(elemTag, v.value));
        }
      }
    }

    const suffix = arrayLength > actualLength + firstIndex ? `, ... (${arrayLength} total)` : "";
    return `[${values.join(", ")}${suffix}]`;
  }

  // === Breakpoints ===

  /**
   * Resolve a class by name, waiting for it to load if not yet available.
   * Returns the classId and the original class lookup results.
   */
  private async resolveClass(
    className: string,
  ): Promise<{ classId: bigint; refTypeTag: number }> {
    const jniSig = classNameToJNISignature(className);
    const classes = await this.getClassesBySignature(jniSig);

    if (classes.length === 0) {
      const classId = await this.waitForClassPrepare(className);
      return { classId, refTypeTag: TypeTag.Class };
    }
    return { classId: classes[0].typeID, refTypeTag: classes[0].refTypeTag };
  }

  /**
   * Register a breakpoint event request at a specific location and track it.
   */
  private async registerBreakpoint(
    className: string,
    line: number,
    suspendPolicy: BreakpointSuspendPolicy,
    refTypeTag: number,
    classId: bigint,
    methodId: bigint,
    codeIndex: bigint,
  ): Promise<BreakpointInfo> {
    const jdwpSuspendPolicy =
      suspendPolicy === "all" ? SuspendPolicy.All : SuspendPolicy.EventThread;

    const requestId = await this.sendRequest(
      CommandSet.EventRequest,
      EventRequestCommand.Set,
      (w) => {
        w.writeByte(EventKind.Breakpoint);
        w.writeByte(jdwpSuspendPolicy);
        w.writeInt(1); // modifier count
        w.writeByte(ModKind.LocationOnly);
        w.writeLocation(refTypeTag, classId, methodId, codeIndex);
      },
      (r) => r.readInt(),
    );

    const bp: BreakpointInfo = {
      requestId,
      className,
      line,
      suspendPolicy,
      classId,
      methodId,
    };
    this.breakpoints.set(requestId, bp);
    return bp;
  }

  async setBreakpoint(
    className: string,
    line: number,
    suspendPolicy: BreakpointSuspendPolicy = "thread",
  ): Promise<BreakpointInfo> {
    const { classId, refTypeTag } = await this.resolveClass(className);

    // Find the method and code index for the given line
    const methods = await this.getMethods(classId);
    let bestMethod: { methodID: bigint } | null = null;
    let bestCodeIndex: bigint | null = null;
    let bestLine = -1;

    for (const method of methods) {
      try {
        const lineTable = await this.getLineTable(classId, method.methodID);
        for (const entry of lineTable.lines) {
          if (entry.lineNumber === line) {
            bestMethod = method;
            bestCodeIndex = entry.lineCodeIndex;
            bestLine = entry.lineNumber;
            break;
          }
        }
        if (bestMethod) break;
      } catch {
        // Method might not have line info
        continue;
      }
    }

    if (!bestMethod || bestCodeIndex === null) {
      throw new Error(
        `Cannot find line ${line} in class ${className}. Make sure the class is compiled with debug info.`,
      );
    }

    const bp = await this.registerBreakpoint(
      className,
      bestLine,
      suspendPolicy,
      refTypeTag,
      classId,
      bestMethod.methodID,
      bestCodeIndex,
    );

    // Resume VM now that breakpoint is in place (it may have been suspended by ClassPrepare)
    if (this.threadState.vmSuspended) {
      await this.resumeVM();
    }

    return bp;
  }

  async setBreakpointByMethod(
    className: string,
    methodName: string,
    suspendPolicy: BreakpointSuspendPolicy = "thread",
  ): Promise<BreakpointInfo> {
    const { classId, refTypeTag } = await this.resolveClass(className);

    const methods = await this.getMethods(classId);
    const targetMethod = methods.find((m) => m.name === methodName);
    if (!targetMethod) {
      const available = methods
        .filter((m) => !m.name.startsWith("<") || m.name === "<init>")
        .map((m) => m.name);
      throw new Error(
        `Method '${methodName}' not found in class ${className}. Available methods: ${available.join(", ")}`,
      );
    }

    const lineTable = await this.getLineTable(classId, targetMethod.methodID);
    if (lineTable.lines.length === 0) {
      throw new Error(
        `No line information for method '${methodName}' in class ${className}. Make sure the class is compiled with debug info.`,
      );
    }

    const firstLine = lineTable.lines[0];
    const bp = await this.registerBreakpoint(
      className,
      firstLine.lineNumber,
      suspendPolicy,
      refTypeTag,
      classId,
      targetMethod.methodID,
      firstLine.lineCodeIndex,
    );

    // Resume VM now that breakpoint is in place (it may have been suspended by ClassPrepare)
    if (this.threadState.vmSuspended) {
      await this.resumeVM();
    }

    return bp;
  }

  private async waitForClassPrepare(className: string): Promise<bigint> {
    const requestId = await this.sendRequest(
      CommandSet.EventRequest,
      EventRequestCommand.Set,
      (w) => {
        w.writeByte(EventKind.ClassPrepare);
        w.writeByte(SuspendPolicy.All);
        w.writeInt(1); // modifier count
        w.writeByte(ModKind.ClassMatch);
        w.writeString(className);
      },
      (r) => r.readInt(),
    );

    // Resume VM so the class can actually load.
    // ClassPrepare uses SuspendPolicy.All, so VM will re-suspend when the class loads.
    if (this.threadState.vmSuspended) {
      await this.resumeVM();
    }

    return await new Promise<bigint>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.classPrepareRequests.delete(className);
        this.clearEventRequest(EventKind.ClassPrepare, requestId).catch(() => {});
        reject(
          new Error(
            `Timeout waiting for class ${className} to load. Make sure the class exists and will be loaded.`,
          ),
        );
      }, 30000);

      this.classPrepareRequests.set(className, {
        resolve: (classId: bigint) => {
          clearTimeout(timeout);
          resolve(classId);
        },
        requestId,
      });
    });
  }

  async removeBreakpoint(requestId: number): Promise<void> {
    await this.clearEventRequest(EventKind.Breakpoint, requestId);
    this.breakpoints.delete(requestId);
  }

  async clearAllBreakpoints(): Promise<void> {
    const reply = await this.sendCommand(
      CommandSet.EventRequest,
      EventRequestCommand.ClearAllBreakpoints,
    );
    this.checkError(reply);
    this.breakpoints.clear();
  }

  private async clearEventRequest(eventKind: number, requestId: number): Promise<void> {
    await this.sendRequest(
      CommandSet.EventRequest,
      EventRequestCommand.Clear,
      (w) => {
        w.writeByte(eventKind);
        w.writeInt(requestId);
      },
      () => undefined,
    );
  }

  getBreakpoints(): BreakpointInfo[] {
    return Array.from(this.breakpoints.values());
  }

  // === Stepping ===

  private async performStep(threadId: bigint, depth: number): Promise<void> {
    await this.createStepRequest(threadId, StepSize.Line, depth);
    // Resume only this thread so other suspended threads remain paused
    this.markThreadResumed(threadId);
    await this.resumeThread(threadId);
  }

  async stepOver(threadId: bigint): Promise<void> {
    return this.performStep(threadId, StepDepth.Over);
  }

  async stepInto(threadId: bigint): Promise<void> {
    return this.performStep(threadId, StepDepth.Into);
  }

  async stepOut(threadId: bigint): Promise<void> {
    return this.performStep(threadId, StepDepth.Out);
  }

  private async createStepRequest(threadId: bigint, size: number, depth: number): Promise<number> {
    return this.sendRequest(
      CommandSet.EventRequest,
      EventRequestCommand.Set,
      (w) => {
        w.writeByte(EventKind.SingleStep);
        w.writeByte(SuspendPolicy.EventThread); // Only suspend the stepping thread
        w.writeInt(1); // modifier count
        w.writeByte(ModKind.Step);
        w.writeThreadID(threadId);
        w.writeInt(size);
        w.writeInt(depth);
      },
      (r) => r.readInt(),
    );
  }
}

// === Helper functions ===

function classNameToJNISignature(className: string): string {
  // Convert "com.example.MyClass" to "Lcom/example/MyClass;"
  // Also handle inner classes: "com.example.MyClass$Inner" stays as is
  return `L${className.replace(/\./g, "/")};`;
}

function jniSignatureToClassName(signature: string): string {
  // Convert "Lcom/example/MyClass;" to "com.example.MyClass"
  let s = signature;
  if (s.startsWith("L") && s.endsWith(";")) {
    s = s.substring(1, s.length - 1);
  }
  return s.replace(/\//g, ".");
}

function signatureToTag(signature: string): number {
  switch (signature.charAt(0)) {
    case "B":
      return Tag.Byte;
    case "C":
      return Tag.Char;
    case "D":
      return Tag.Double;
    case "F":
      return Tag.Float;
    case "I":
      return Tag.Int;
    case "J":
      return Tag.Long;
    case "S":
      return Tag.Short;
    case "V":
      return Tag.Void;
    case "Z":
      return Tag.Boolean;
    case "L":
      return Tag.Object;
    case "[":
      return Tag.Array;
    default:
      return Tag.Object;
  }
}

function formatValue(tag: number, value: unknown): string {
  if (value === null || value === undefined) return "null";

  // value is a primitive (number, bigint, boolean, string) from JDWP protocol reads
  const s = (v: unknown): string => `${v as string | number | bigint | boolean}`;

  switch (tag) {
    case Tag.Boolean:
      return value === true ? "true" : "false";
    case Tag.Byte:
    case Tag.Short:
    case Tag.Int:
      return s(value);
    case Tag.Long:
      return `${s(value)}L`;
    case Tag.Float:
      return `${s(value)}f`;
    case Tag.Double:
      return s(value);
    case Tag.Char:
      return `'${s(value)}'`;
    case Tag.String:
      return value === 0n ? "null" : `String@${s(value)}`;
    case Tag.Null:
      return "null";
    case Tag.Void:
      return "void";
    case Tag.Object:
    case Tag.Array:
    case Tag.Thread:
    case Tag.ThreadGroup:
    case Tag.ClassLoader:
    case Tag.ClassObject:
      return value === 0n ? "null" : `Object@${s(value)}`;
    default:
      return s(value);
  }
}

export { formatValue, jniSignatureToClassName, classNameToJNISignature, signatureToTag };
