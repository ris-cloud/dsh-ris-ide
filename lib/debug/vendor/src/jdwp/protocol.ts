import { FLAGS_REPLY, Tag } from "./constants.js";

// ID sizes (set after IDSizes command)
export interface IDSizes {
  fieldIDSize: number;
  methodIDSize: number;
  objectIDSize: number;
  referenceTypeIDSize: number;
  frameIDSize: number;
}

const defaultIDSizes: IDSizes = {
  fieldIDSize: 8,
  methodIDSize: 8,
  objectIDSize: 8,
  referenceTypeIDSize: 8,
  frameIDSize: 8,
};

// Packet structures
export interface CommandPacket {
  id: number;
  flags: number;
  commandSet: number;
  command: number;
  data: Buffer;
}

export interface ReplyPacket {
  id: number;
  flags: number;
  errorCode: number;
  data: Buffer;
}

// Buffer writer for building JDWP data
export class JDWPWriter {
  private buffers: Buffer[] = [];
  private idSizes: IDSizes;

  constructor(idSizes: IDSizes = defaultIDSizes) {
    this.idSizes = idSizes;
  }

  writeByte(value: number): this {
    const buf = Buffer.alloc(1);
    buf.writeInt8(value, 0);
    this.buffers.push(buf);
    return this;
  }

  writeBoolean(value: boolean): this {
    return this.writeByte(value ? 1 : 0);
  }

  writeShort(value: number): this {
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(value, 0);
    this.buffers.push(buf);
    return this;
  }

  writeInt(value: number): this {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(value, 0);
    this.buffers.push(buf);
    return this;
  }

  writeLong(value: bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(value, 0);
    this.buffers.push(buf);
    return this;
  }

  writeID(value: bigint, size: number): this {
    const buf = Buffer.alloc(size);
    // Write big-endian, right-aligned
    for (let i = size - 1; i >= 0; i--) {
      buf[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    this.buffers.push(buf);
    return this;
  }

  writeObjectID(value: bigint): this {
    return this.writeID(value, this.idSizes.objectIDSize);
  }

  writeReferenceTypeID(value: bigint): this {
    return this.writeID(value, this.idSizes.referenceTypeIDSize);
  }

  writeMethodID(value: bigint): this {
    return this.writeID(value, this.idSizes.methodIDSize);
  }

  writeFieldID(value: bigint): this {
    return this.writeID(value, this.idSizes.fieldIDSize);
  }

  writeFrameID(value: bigint): this {
    return this.writeID(value, this.idSizes.frameIDSize);
  }

  writeThreadID(value: bigint): this {
    return this.writeObjectID(value);
  }

  writeString(value: string): this {
    const strBuf = Buffer.from(value, "utf-8");
    this.writeInt(strBuf.length);
    this.buffers.push(strBuf);
    return this;
  }

  writeLocation(typeTag: number, classID: bigint, methodID: bigint, index: bigint): this {
    this.writeByte(typeTag);
    this.writeReferenceTypeID(classID);
    this.writeMethodID(methodID);
    this.writeLong(index);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.buffers);
  }
}

// Buffer reader for parsing JDWP data
export class JDWPReader {
  private buffer: Buffer;
  private offset: number = 0;
  private idSizes: IDSizes;

  constructor(buffer: Buffer, idSizes: IDSizes = defaultIDSizes) {
    this.buffer = buffer;
    this.idSizes = idSizes;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  readByte(): number {
    const value = this.buffer.readInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readBoolean(): boolean {
    return this.readByte() !== 0;
  }

  readShort(): number {
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readInt(): number {
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readLong(): bigint {
    const value = this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  readID(size: number): bigint {
    let value = 0n;
    for (let i = 0; i < size; i++) {
      value = (value << 8n) | BigInt(this.buffer[this.offset + i]);
    }
    this.offset += size;
    return value;
  }

  readObjectID(): bigint {
    return this.readID(this.idSizes.objectIDSize);
  }

  readReferenceTypeID(): bigint {
    return this.readID(this.idSizes.referenceTypeIDSize);
  }

  readMethodID(): bigint {
    return this.readID(this.idSizes.methodIDSize);
  }

  readFieldID(): bigint {
    return this.readID(this.idSizes.fieldIDSize);
  }

  readFrameID(): bigint {
    return this.readID(this.idSizes.frameIDSize);
  }

  readThreadID(): bigint {
    return this.readObjectID();
  }

  readString(): string {
    const length = this.readInt();
    const value = this.buffer.toString("utf-8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readLocation(): { typeTag: number; classID: bigint; methodID: bigint; index: bigint } {
    const typeTag = this.readByte();
    const classID = this.readReferenceTypeID();
    const methodID = this.readMethodID();
    const index = this.readLong();
    return { typeTag, classID, methodID, index };
  }

  readTaggedObjectID(): { tag: number; objectID: bigint } {
    const tag = this.readByte();
    const objectID = this.readObjectID();
    return { tag, objectID };
  }

  readValue(tag: number): JDWPValue {
    switch (tag) {
      case Tag.Byte:
        return { tag, value: this.readByte() };
      case Tag.Boolean:
        return { tag, value: this.readBoolean() };
      case Tag.Char:
        return { tag, value: String.fromCharCode(this.readShort() & 0xffff) };
      case Tag.Short:
        return { tag, value: this.readShort() };
      case Tag.Int:
        return { tag, value: this.readInt() };
      case Tag.Long:
        return { tag, value: this.readLong() };
      case Tag.Float: {
        const buf = this.buffer.subarray(this.offset, this.offset + 4);
        this.offset += 4;
        return { tag, value: buf.readFloatBE(0) };
      }
      case Tag.Double: {
        const buf = this.buffer.subarray(this.offset, this.offset + 8);
        this.offset += 8;
        return { tag, value: buf.readDoubleBE(0) };
      }
      case Tag.Void:
        return { tag, value: null };
      case Tag.Null:
        return { tag, value: null };
      case Tag.String:
      case Tag.Object:
      case Tag.Array:
      case Tag.Thread:
      case Tag.ThreadGroup:
      case Tag.ClassLoader:
      case Tag.ClassObject:
        return { tag, value: this.readObjectID() };
      default:
        return { tag, value: this.readObjectID() };
    }
  }

  readUntaggedValue(tag: number): JDWPValue {
    return this.readValue(tag);
  }
}

export interface JDWPValue {
  tag: number;
  value: number | bigint | boolean | string | null;
}

// Build a command packet
export function buildCommandPacket(
  id: number,
  commandSet: number,
  command: number,
  data: Buffer = Buffer.alloc(0),
): Buffer {
  const length = 11 + data.length;
  const header = Buffer.alloc(11);
  header.writeInt32BE(length, 0);
  header.writeInt32BE(id, 4);
  header.writeUInt8(0, 8); // flags
  header.writeUInt8(commandSet, 9);
  header.writeUInt8(command, 10);
  return Buffer.concat([header, data]);
}

// Parse a reply packet from buffer
export function parseReplyPacket(buffer: Buffer): ReplyPacket | null {
  if (buffer.length < 11) return null;
  const length = buffer.readInt32BE(0);
  if (buffer.length < length) return null;

  return {
    id: buffer.readInt32BE(4),
    flags: buffer.readUInt8(8),
    errorCode: buffer.readUInt16BE(9),
    data: buffer.subarray(11, length),
  };
}

// Check if buffer has a complete packet
export function hasCompletePacket(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const length = buffer.readInt32BE(0);
  return buffer.length >= length;
}

export function getPacketLength(buffer: Buffer): number {
  if (buffer.length < 4) return -1;
  return buffer.readInt32BE(0);
}

export function isReplyPacket(buffer: Buffer): boolean {
  if (buffer.length < 9) return false;
  return (buffer.readUInt8(8) & FLAGS_REPLY) !== 0;
}
