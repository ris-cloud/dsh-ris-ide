// JDWP Command Sets and Commands
// Reference: https://docs.oracle.com/en/java/javase/17/docs/specs/jdwp/jdwp-protocol.html
export const HANDSHAKE = "JDWP-Handshake";
// Packet flags
export const FLAGS_REPLY = 0x80;
// Command Sets
export var CommandSet;
(function (CommandSet) {
    CommandSet[CommandSet["VirtualMachine"] = 1] = "VirtualMachine";
    CommandSet[CommandSet["ReferenceType"] = 2] = "ReferenceType";
    CommandSet[CommandSet["ClassType"] = 3] = "ClassType";
    CommandSet[CommandSet["ArrayType"] = 4] = "ArrayType";
    CommandSet[CommandSet["InterfaceType"] = 5] = "InterfaceType";
    CommandSet[CommandSet["Method"] = 6] = "Method";
    CommandSet[CommandSet["Field"] = 8] = "Field";
    CommandSet[CommandSet["ObjectReference"] = 9] = "ObjectReference";
    CommandSet[CommandSet["StringReference"] = 10] = "StringReference";
    CommandSet[CommandSet["ThreadReference"] = 11] = "ThreadReference";
    CommandSet[CommandSet["ThreadGroupReference"] = 12] = "ThreadGroupReference";
    CommandSet[CommandSet["ArrayReference"] = 13] = "ArrayReference";
    CommandSet[CommandSet["ClassLoaderReference"] = 14] = "ClassLoaderReference";
    CommandSet[CommandSet["EventRequest"] = 15] = "EventRequest";
    CommandSet[CommandSet["StackFrame"] = 16] = "StackFrame";
    CommandSet[CommandSet["ClassObjectReference"] = 17] = "ClassObjectReference";
    CommandSet[CommandSet["ModuleReference"] = 18] = "ModuleReference";
    CommandSet[CommandSet["Event"] = 64] = "Event";
})(CommandSet || (CommandSet = {}));
// VirtualMachine commands
export var VMCommand;
(function (VMCommand) {
    VMCommand[VMCommand["Version"] = 1] = "Version";
    VMCommand[VMCommand["ClassesBySignature"] = 2] = "ClassesBySignature";
    VMCommand[VMCommand["AllClasses"] = 3] = "AllClasses";
    VMCommand[VMCommand["AllThreads"] = 4] = "AllThreads";
    VMCommand[VMCommand["TopLevelThreadGroups"] = 5] = "TopLevelThreadGroups";
    VMCommand[VMCommand["Dispose"] = 6] = "Dispose";
    VMCommand[VMCommand["IDSizes"] = 7] = "IDSizes";
    VMCommand[VMCommand["Suspend"] = 8] = "Suspend";
    VMCommand[VMCommand["Resume"] = 9] = "Resume";
    VMCommand[VMCommand["Exit"] = 10] = "Exit";
    VMCommand[VMCommand["CreateString"] = 11] = "CreateString";
    VMCommand[VMCommand["Capabilities"] = 12] = "Capabilities";
    VMCommand[VMCommand["ClassPaths"] = 13] = "ClassPaths";
    VMCommand[VMCommand["DisposeObjects"] = 14] = "DisposeObjects";
    VMCommand[VMCommand["HoldEvents"] = 15] = "HoldEvents";
    VMCommand[VMCommand["ReleaseEvents"] = 16] = "ReleaseEvents";
    VMCommand[VMCommand["CapabilitiesNew"] = 17] = "CapabilitiesNew";
    VMCommand[VMCommand["RedefineClasses"] = 18] = "RedefineClasses";
    VMCommand[VMCommand["SetDefaultStratum"] = 19] = "SetDefaultStratum";
    VMCommand[VMCommand["AllClassesWithGeneric"] = 20] = "AllClassesWithGeneric";
    VMCommand[VMCommand["InstanceCounts"] = 21] = "InstanceCounts";
    VMCommand[VMCommand["AllModules"] = 22] = "AllModules";
})(VMCommand || (VMCommand = {}));
// ReferenceType commands
export var ReferenceTypeCommand;
(function (ReferenceTypeCommand) {
    ReferenceTypeCommand[ReferenceTypeCommand["Signature"] = 1] = "Signature";
    ReferenceTypeCommand[ReferenceTypeCommand["ClassLoader"] = 2] = "ClassLoader";
    ReferenceTypeCommand[ReferenceTypeCommand["Modifiers"] = 3] = "Modifiers";
    ReferenceTypeCommand[ReferenceTypeCommand["Fields"] = 4] = "Fields";
    ReferenceTypeCommand[ReferenceTypeCommand["Methods"] = 5] = "Methods";
    ReferenceTypeCommand[ReferenceTypeCommand["GetValues"] = 6] = "GetValues";
    ReferenceTypeCommand[ReferenceTypeCommand["SourceFile"] = 7] = "SourceFile";
    ReferenceTypeCommand[ReferenceTypeCommand["NestedTypes"] = 8] = "NestedTypes";
    ReferenceTypeCommand[ReferenceTypeCommand["Status"] = 9] = "Status";
    ReferenceTypeCommand[ReferenceTypeCommand["Interfaces"] = 10] = "Interfaces";
    ReferenceTypeCommand[ReferenceTypeCommand["ClassObject"] = 11] = "ClassObject";
    ReferenceTypeCommand[ReferenceTypeCommand["SourceDebugExtension"] = 12] = "SourceDebugExtension";
    ReferenceTypeCommand[ReferenceTypeCommand["SignatureWithGeneric"] = 13] = "SignatureWithGeneric";
    ReferenceTypeCommand[ReferenceTypeCommand["FieldsWithGeneric"] = 14] = "FieldsWithGeneric";
    ReferenceTypeCommand[ReferenceTypeCommand["MethodsWithGeneric"] = 15] = "MethodsWithGeneric";
    ReferenceTypeCommand[ReferenceTypeCommand["Instances"] = 16] = "Instances";
    ReferenceTypeCommand[ReferenceTypeCommand["ClassFileVersion"] = 17] = "ClassFileVersion";
    ReferenceTypeCommand[ReferenceTypeCommand["ConstantPool"] = 18] = "ConstantPool";
    ReferenceTypeCommand[ReferenceTypeCommand["Module"] = 19] = "Module";
})(ReferenceTypeCommand || (ReferenceTypeCommand = {}));
// Method commands
export var MethodCommand;
(function (MethodCommand) {
    MethodCommand[MethodCommand["LineTable"] = 1] = "LineTable";
    MethodCommand[MethodCommand["VariableTable"] = 2] = "VariableTable";
    MethodCommand[MethodCommand["Bytecodes"] = 3] = "Bytecodes";
    MethodCommand[MethodCommand["IsObsolete"] = 4] = "IsObsolete";
    MethodCommand[MethodCommand["VariableTableWithGeneric"] = 5] = "VariableTableWithGeneric";
})(MethodCommand || (MethodCommand = {}));
// ThreadReference commands
export var ThreadCommand;
(function (ThreadCommand) {
    ThreadCommand[ThreadCommand["Name"] = 1] = "Name";
    ThreadCommand[ThreadCommand["Suspend"] = 2] = "Suspend";
    ThreadCommand[ThreadCommand["Resume"] = 3] = "Resume";
    ThreadCommand[ThreadCommand["Status"] = 4] = "Status";
    ThreadCommand[ThreadCommand["ThreadGroup"] = 5] = "ThreadGroup";
    ThreadCommand[ThreadCommand["Frames"] = 6] = "Frames";
    ThreadCommand[ThreadCommand["FrameCount"] = 7] = "FrameCount";
    ThreadCommand[ThreadCommand["OwnedMonitors"] = 8] = "OwnedMonitors";
    ThreadCommand[ThreadCommand["CurrentContendedMonitor"] = 9] = "CurrentContendedMonitor";
    ThreadCommand[ThreadCommand["Stop"] = 10] = "Stop";
    ThreadCommand[ThreadCommand["Interrupt"] = 11] = "Interrupt";
    ThreadCommand[ThreadCommand["SuspendCount"] = 12] = "SuspendCount";
    ThreadCommand[ThreadCommand["OwnedMonitorsStackDepthInfo"] = 13] = "OwnedMonitorsStackDepthInfo";
    ThreadCommand[ThreadCommand["ForceEarlyReturn"] = 14] = "ForceEarlyReturn";
})(ThreadCommand || (ThreadCommand = {}));
// StackFrame commands
export var StackFrameCommand;
(function (StackFrameCommand) {
    StackFrameCommand[StackFrameCommand["GetValues"] = 1] = "GetValues";
    StackFrameCommand[StackFrameCommand["SetValues"] = 2] = "SetValues";
    StackFrameCommand[StackFrameCommand["ThisObject"] = 3] = "ThisObject";
    StackFrameCommand[StackFrameCommand["PopFrames"] = 4] = "PopFrames";
})(StackFrameCommand || (StackFrameCommand = {}));
// EventRequest commands
export var EventRequestCommand;
(function (EventRequestCommand) {
    EventRequestCommand[EventRequestCommand["Set"] = 1] = "Set";
    EventRequestCommand[EventRequestCommand["Clear"] = 2] = "Clear";
    EventRequestCommand[EventRequestCommand["ClearAllBreakpoints"] = 3] = "ClearAllBreakpoints";
})(EventRequestCommand || (EventRequestCommand = {}));
// StringReference commands
export var StringReferenceCommand;
(function (StringReferenceCommand) {
    StringReferenceCommand[StringReferenceCommand["Value"] = 1] = "Value";
})(StringReferenceCommand || (StringReferenceCommand = {}));
// ObjectReference commands
export var ObjectReferenceCommand;
(function (ObjectReferenceCommand) {
    ObjectReferenceCommand[ObjectReferenceCommand["ReferenceType"] = 1] = "ReferenceType";
    ObjectReferenceCommand[ObjectReferenceCommand["GetValues"] = 2] = "GetValues";
    ObjectReferenceCommand[ObjectReferenceCommand["SetValues"] = 3] = "SetValues";
    ObjectReferenceCommand[ObjectReferenceCommand["MonitorInfo"] = 5] = "MonitorInfo";
    ObjectReferenceCommand[ObjectReferenceCommand["InvokeMethod"] = 6] = "InvokeMethod";
    ObjectReferenceCommand[ObjectReferenceCommand["DisableCollection"] = 7] = "DisableCollection";
    ObjectReferenceCommand[ObjectReferenceCommand["EnableCollection"] = 8] = "EnableCollection";
    ObjectReferenceCommand[ObjectReferenceCommand["IsCollected"] = 9] = "IsCollected";
    ObjectReferenceCommand[ObjectReferenceCommand["ReferringObjects"] = 10] = "ReferringObjects";
})(ObjectReferenceCommand || (ObjectReferenceCommand = {}));
// ArrayReference commands
export var ArrayReferenceCommand;
(function (ArrayReferenceCommand) {
    ArrayReferenceCommand[ArrayReferenceCommand["Length"] = 1] = "Length";
    ArrayReferenceCommand[ArrayReferenceCommand["GetValues"] = 2] = "GetValues";
    ArrayReferenceCommand[ArrayReferenceCommand["SetValues"] = 3] = "SetValues";
})(ArrayReferenceCommand || (ArrayReferenceCommand = {}));
// Event kinds
export var EventKind;
(function (EventKind) {
    EventKind[EventKind["SingleStep"] = 1] = "SingleStep";
    EventKind[EventKind["Breakpoint"] = 2] = "Breakpoint";
    EventKind[EventKind["FramePop"] = 3] = "FramePop";
    EventKind[EventKind["Exception"] = 4] = "Exception";
    EventKind[EventKind["UserDefined"] = 5] = "UserDefined";
    EventKind[EventKind["ThreadStart"] = 6] = "ThreadStart";
    EventKind[EventKind["ThreadDeath"] = 7] = "ThreadDeath";
    EventKind[EventKind["ClassPrepare"] = 8] = "ClassPrepare";
    EventKind[EventKind["ClassUnload"] = 9] = "ClassUnload";
    EventKind[EventKind["ClassLoad"] = 10] = "ClassLoad";
    EventKind[EventKind["FieldAccess"] = 20] = "FieldAccess";
    EventKind[EventKind["FieldModification"] = 21] = "FieldModification";
    EventKind[EventKind["ExceptionCatch"] = 30] = "ExceptionCatch";
    EventKind[EventKind["MethodEntry"] = 40] = "MethodEntry";
    EventKind[EventKind["MethodExit"] = 41] = "MethodExit";
    EventKind[EventKind["MethodExitWithReturnValue"] = 42] = "MethodExitWithReturnValue";
    EventKind[EventKind["MonitorContendedEnter"] = 43] = "MonitorContendedEnter";
    EventKind[EventKind["MonitorContendedEntered"] = 44] = "MonitorContendedEntered";
    EventKind[EventKind["MonitorWait"] = 45] = "MonitorWait";
    EventKind[EventKind["MonitorWaited"] = 46] = "MonitorWaited";
    EventKind[EventKind["VMStart"] = 90] = "VMStart";
    EventKind[EventKind["VMDeath"] = 99] = "VMDeath";
})(EventKind || (EventKind = {}));
// Suspend policy
export var SuspendPolicy;
(function (SuspendPolicy) {
    SuspendPolicy[SuspendPolicy["None"] = 0] = "None";
    SuspendPolicy[SuspendPolicy["EventThread"] = 1] = "EventThread";
    SuspendPolicy[SuspendPolicy["All"] = 2] = "All";
})(SuspendPolicy || (SuspendPolicy = {}));
// Step size
export var StepSize;
(function (StepSize) {
    StepSize[StepSize["Min"] = 0] = "Min";
    StepSize[StepSize["Line"] = 1] = "Line";
})(StepSize || (StepSize = {}));
// Step depth
export var StepDepth;
(function (StepDepth) {
    StepDepth[StepDepth["Into"] = 0] = "Into";
    StepDepth[StepDepth["Over"] = 1] = "Over";
    StepDepth[StepDepth["Out"] = 2] = "Out";
})(StepDepth || (StepDepth = {}));
// Type tags
export var TypeTag;
(function (TypeTag) {
    TypeTag[TypeTag["Class"] = 1] = "Class";
    TypeTag[TypeTag["Interface"] = 2] = "Interface";
    TypeTag[TypeTag["Array"] = 3] = "Array";
})(TypeTag || (TypeTag = {}));
// Tag values for primitive/object types
export var Tag;
(function (Tag) {
    Tag[Tag["Array"] = 91] = "Array";
    Tag[Tag["Byte"] = 66] = "Byte";
    Tag[Tag["Char"] = 67] = "Char";
    Tag[Tag["Object"] = 76] = "Object";
    Tag[Tag["Float"] = 70] = "Float";
    Tag[Tag["Double"] = 68] = "Double";
    Tag[Tag["Int"] = 73] = "Int";
    Tag[Tag["Long"] = 74] = "Long";
    Tag[Tag["Short"] = 83] = "Short";
    Tag[Tag["Void"] = 86] = "Void";
    Tag[Tag["Boolean"] = 90] = "Boolean";
    Tag[Tag["String"] = 115] = "String";
    Tag[Tag["Thread"] = 116] = "Thread";
    Tag[Tag["ThreadGroup"] = 103] = "ThreadGroup";
    Tag[Tag["ClassLoader"] = 108] = "ClassLoader";
    Tag[Tag["ClassObject"] = 99] = "ClassObject";
    Tag[Tag["Null"] = 110] = "Null";
})(Tag || (Tag = {}));
// Thread status
export var ThreadStatus;
(function (ThreadStatus) {
    ThreadStatus[ThreadStatus["Zombie"] = 0] = "Zombie";
    ThreadStatus[ThreadStatus["Running"] = 1] = "Running";
    ThreadStatus[ThreadStatus["Sleeping"] = 2] = "Sleeping";
    ThreadStatus[ThreadStatus["Monitor"] = 3] = "Monitor";
    ThreadStatus[ThreadStatus["Wait"] = 4] = "Wait";
})(ThreadStatus || (ThreadStatus = {}));
// Suspend status
export var SuspendStatus;
(function (SuspendStatus) {
    SuspendStatus[SuspendStatus["Suspended"] = 1] = "Suspended";
})(SuspendStatus || (SuspendStatus = {}));
// Event modifier kinds
export var ModKind;
(function (ModKind) {
    ModKind[ModKind["Count"] = 1] = "Count";
    ModKind[ModKind["Conditional"] = 2] = "Conditional";
    ModKind[ModKind["ThreadOnly"] = 3] = "ThreadOnly";
    ModKind[ModKind["ClassOnly"] = 4] = "ClassOnly";
    ModKind[ModKind["ClassMatch"] = 5] = "ClassMatch";
    ModKind[ModKind["ClassExclude"] = 6] = "ClassExclude";
    ModKind[ModKind["LocationOnly"] = 7] = "LocationOnly";
    ModKind[ModKind["ExceptionOnly"] = 8] = "ExceptionOnly";
    ModKind[ModKind["FieldOnly"] = 9] = "FieldOnly";
    ModKind[ModKind["Step"] = 10] = "Step";
    ModKind[ModKind["InstanceOnly"] = 11] = "InstanceOnly";
    ModKind[ModKind["SourceNameMatch"] = 12] = "SourceNameMatch";
})(ModKind || (ModKind = {}));
// JDWP error codes
export var JDWPError;
(function (JDWPError) {
    JDWPError[JDWPError["None"] = 0] = "None";
    JDWPError[JDWPError["InvalidThread"] = 10] = "InvalidThread";
    JDWPError[JDWPError["InvalidThreadGroup"] = 11] = "InvalidThreadGroup";
    JDWPError[JDWPError["InvalidPriority"] = 12] = "InvalidPriority";
    JDWPError[JDWPError["ThreadNotSuspended"] = 13] = "ThreadNotSuspended";
    JDWPError[JDWPError["ThreadSuspended"] = 14] = "ThreadSuspended";
    JDWPError[JDWPError["ThreadNotAlive"] = 15] = "ThreadNotAlive";
    JDWPError[JDWPError["InvalidObject"] = 20] = "InvalidObject";
    JDWPError[JDWPError["InvalidClass"] = 21] = "InvalidClass";
    JDWPError[JDWPError["ClassNotPrepared"] = 22] = "ClassNotPrepared";
    JDWPError[JDWPError["InvalidMethodid"] = 23] = "InvalidMethodid";
    JDWPError[JDWPError["InvalidLocation"] = 24] = "InvalidLocation";
    JDWPError[JDWPError["InvalidFieldid"] = 25] = "InvalidFieldid";
    JDWPError[JDWPError["InvalidFrameid"] = 30] = "InvalidFrameid";
    JDWPError[JDWPError["NoMoreFrames"] = 31] = "NoMoreFrames";
    JDWPError[JDWPError["OpaqueFrame"] = 32] = "OpaqueFrame";
    JDWPError[JDWPError["NotCurrentFrame"] = 33] = "NotCurrentFrame";
    JDWPError[JDWPError["TypeMismatch"] = 34] = "TypeMismatch";
    JDWPError[JDWPError["InvalidSlot"] = 35] = "InvalidSlot";
    JDWPError[JDWPError["Duplicate"] = 40] = "Duplicate";
    JDWPError[JDWPError["NotFound"] = 41] = "NotFound";
    JDWPError[JDWPError["InvalidMonitor"] = 50] = "InvalidMonitor";
    JDWPError[JDWPError["NotMonitorOwner"] = 51] = "NotMonitorOwner";
    JDWPError[JDWPError["Interrupt"] = 52] = "Interrupt";
    JDWPError[JDWPError["InvalidClassFormat"] = 60] = "InvalidClassFormat";
    JDWPError[JDWPError["CircularClassDefinition"] = 61] = "CircularClassDefinition";
    JDWPError[JDWPError["FailsVerification"] = 62] = "FailsVerification";
    JDWPError[JDWPError["AddMethodNotImplemented"] = 63] = "AddMethodNotImplemented";
    JDWPError[JDWPError["SchemaChangeNotImplemented"] = 64] = "SchemaChangeNotImplemented";
    JDWPError[JDWPError["InvalidTypestate"] = 65] = "InvalidTypestate";
    JDWPError[JDWPError["HierarchyChangeNotImplemented"] = 66] = "HierarchyChangeNotImplemented";
    JDWPError[JDWPError["DeleteMethodNotImplemented"] = 67] = "DeleteMethodNotImplemented";
    JDWPError[JDWPError["UnsupportedVersion"] = 68] = "UnsupportedVersion";
    JDWPError[JDWPError["NamesMismatch"] = 69] = "NamesMismatch";
    JDWPError[JDWPError["ClassModifiersChangeNotImplemented"] = 70] = "ClassModifiersChangeNotImplemented";
    JDWPError[JDWPError["MethodModifiersChangeNotImplemented"] = 71] = "MethodModifiersChangeNotImplemented";
    JDWPError[JDWPError["NotImplemented"] = 99] = "NotImplemented";
    JDWPError[JDWPError["NullPointer"] = 100] = "NullPointer";
    JDWPError[JDWPError["AbsentInformation"] = 101] = "AbsentInformation";
    JDWPError[JDWPError["InvalidEventType"] = 102] = "InvalidEventType";
    JDWPError[JDWPError["IllegalArgument"] = 103] = "IllegalArgument";
    JDWPError[JDWPError["OutOfMemory"] = 110] = "OutOfMemory";
    JDWPError[JDWPError["AccessDenied"] = 111] = "AccessDenied";
    JDWPError[JDWPError["VmDead"] = 112] = "VmDead";
    JDWPError[JDWPError["Internal"] = 113] = "Internal";
    JDWPError[JDWPError["UnattachedThread"] = 115] = "UnattachedThread";
    JDWPError[JDWPError["InvalidTag"] = 500] = "InvalidTag";
    JDWPError[JDWPError["AlreadyInvoking"] = 502] = "AlreadyInvoking";
    JDWPError[JDWPError["InvalidIndex"] = 503] = "InvalidIndex";
    JDWPError[JDWPError["InvalidLength"] = 504] = "InvalidLength";
    JDWPError[JDWPError["InvalidString"] = 506] = "InvalidString";
    JDWPError[JDWPError["InvalidClassLoader"] = 507] = "InvalidClassLoader";
    JDWPError[JDWPError["InvalidArray"] = 508] = "InvalidArray";
    JDWPError[JDWPError["TransportLoad"] = 509] = "TransportLoad";
    JDWPError[JDWPError["TransportInit"] = 510] = "TransportInit";
    JDWPError[JDWPError["NativeMethod"] = 511] = "NativeMethod";
    JDWPError[JDWPError["InvalidCount"] = 512] = "InvalidCount";
})(JDWPError || (JDWPError = {}));
//# sourceMappingURL=constants.js.map