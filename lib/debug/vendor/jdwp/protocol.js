import { FLAGS_REPLY, Tag } from "./constants.js";
const defaultIDSizes = {
    fieldIDSize: 8,
    methodIDSize: 8,
    objectIDSize: 8,
    referenceTypeIDSize: 8,
    frameIDSize: 8,
};
// Buffer writer for building JDWP data
export class JDWPWriter {
    buffers = [];
    idSizes;
    constructor(idSizes = defaultIDSizes) {
        this.idSizes = idSizes;
    }
    writeByte(value) {
        const buf = Buffer.alloc(1);
        buf.writeInt8(value, 0);
        this.buffers.push(buf);
        return this;
    }
    writeBoolean(value) {
        return this.writeByte(value ? 1 : 0);
    }
    writeShort(value) {
        const buf = Buffer.alloc(2);
        buf.writeInt16BE(value, 0);
        this.buffers.push(buf);
        return this;
    }
    writeInt(value) {
        const buf = Buffer.alloc(4);
        buf.writeInt32BE(value, 0);
        this.buffers.push(buf);
        return this;
    }
    writeLong(value) {
        const buf = Buffer.alloc(8);
        buf.writeBigInt64BE(value, 0);
        this.buffers.push(buf);
        return this;
    }
    writeID(value, size) {
        const buf = Buffer.alloc(size);
        // Write big-endian, right-aligned
        for (let i = size - 1; i >= 0; i--) {
            buf[i] = Number(value & 0xffn);
            value >>= 8n;
        }
        this.buffers.push(buf);
        return this;
    }
    writeObjectID(value) {
        return this.writeID(value, this.idSizes.objectIDSize);
    }
    writeReferenceTypeID(value) {
        return this.writeID(value, this.idSizes.referenceTypeIDSize);
    }
    writeMethodID(value) {
        return this.writeID(value, this.idSizes.methodIDSize);
    }
    writeFieldID(value) {
        return this.writeID(value, this.idSizes.fieldIDSize);
    }
    writeFrameID(value) {
        return this.writeID(value, this.idSizes.frameIDSize);
    }
    writeThreadID(value) {
        return this.writeObjectID(value);
    }
    writeString(value) {
        const strBuf = Buffer.from(value, "utf-8");
        this.writeInt(strBuf.length);
        this.buffers.push(strBuf);
        return this;
    }
    writeLocation(typeTag, classID, methodID, index) {
        this.writeByte(typeTag);
        this.writeReferenceTypeID(classID);
        this.writeMethodID(methodID);
        this.writeLong(index);
        return this;
    }
    toBuffer() {
        return Buffer.concat(this.buffers);
    }
}
// Buffer reader for parsing JDWP data
export class JDWPReader {
    buffer;
    offset = 0;
    idSizes;
    constructor(buffer, idSizes = defaultIDSizes) {
        this.buffer = buffer;
        this.idSizes = idSizes;
    }
    get remaining() {
        return this.buffer.length - this.offset;
    }
    readByte() {
        const value = this.buffer.readInt8(this.offset);
        this.offset += 1;
        return value;
    }
    readBoolean() {
        return this.readByte() !== 0;
    }
    readShort() {
        const value = this.buffer.readInt16BE(this.offset);
        this.offset += 2;
        return value;
    }
    readInt() {
        const value = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return value;
    }
    readLong() {
        const value = this.buffer.readBigInt64BE(this.offset);
        this.offset += 8;
        return value;
    }
    readID(size) {
        let value = 0n;
        for (let i = 0; i < size; i++) {
            value = (value << 8n) | BigInt(this.buffer[this.offset + i]);
        }
        this.offset += size;
        return value;
    }
    readObjectID() {
        return this.readID(this.idSizes.objectIDSize);
    }
    readReferenceTypeID() {
        return this.readID(this.idSizes.referenceTypeIDSize);
    }
    readMethodID() {
        return this.readID(this.idSizes.methodIDSize);
    }
    readFieldID() {
        return this.readID(this.idSizes.fieldIDSize);
    }
    readFrameID() {
        return this.readID(this.idSizes.frameIDSize);
    }
    readThreadID() {
        return this.readObjectID();
    }
    readString() {
        const length = this.readInt();
        const value = this.buffer.toString("utf-8", this.offset, this.offset + length);
        this.offset += length;
        return value;
    }
    readLocation() {
        const typeTag = this.readByte();
        const classID = this.readReferenceTypeID();
        const methodID = this.readMethodID();
        const index = this.readLong();
        return { typeTag, classID, methodID, index };
    }
    readTaggedObjectID() {
        const tag = this.readByte();
        const objectID = this.readObjectID();
        return { tag, objectID };
    }
    readValue(tag) {
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
    readUntaggedValue(tag) {
        return this.readValue(tag);
    }
}
// Build a command packet
export function buildCommandPacket(id, commandSet, command, data = Buffer.alloc(0)) {
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
export function parseReplyPacket(buffer) {
    if (buffer.length < 11)
        return null;
    const length = buffer.readInt32BE(0);
    if (buffer.length < length)
        return null;
    return {
        id: buffer.readInt32BE(4),
        flags: buffer.readUInt8(8),
        errorCode: buffer.readUInt16BE(9),
        data: buffer.subarray(11, length),
    };
}
// Check if buffer has a complete packet
export function hasCompletePacket(buffer) {
    if (buffer.length < 4)
        return false;
    const length = buffer.readInt32BE(0);
    return buffer.length >= length;
}
export function getPacketLength(buffer) {
    if (buffer.length < 4)
        return -1;
    return buffer.readInt32BE(0);
}
export function isReplyPacket(buffer) {
    if (buffer.length < 9)
        return false;
    return (buffer.readUInt8(8) & FLAGS_REPLY) !== 0;
}
//# sourceMappingURL=protocol.js.map