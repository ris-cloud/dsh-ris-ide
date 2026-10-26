// JDWP Command Sets and Commands
// Reference: https://docs.oracle.com/en/java/javase/17/docs/specs/jdwp/jdwp-protocol.html

export const HANDSHAKE = "JDWP-Handshake";

// Packet flags
export const FLAGS_REPLY = 0x80;

// Command Sets
export const enum CommandSet {
  VirtualMachine = 1,
  ReferenceType = 2,
  ClassType = 3,
  ArrayType = 4,
  InterfaceType = 5,
  Method = 6,
  Field = 8,
  ObjectReference = 9,
  StringReference = 10,
  ThreadReference = 11,
  ThreadGroupReference = 12,
  ArrayReference = 13,
  ClassLoaderReference = 14,
  EventRequest = 15,
  StackFrame = 16,
  ClassObjectReference = 17,
  ModuleReference = 18,
  Event = 64,
}

// VirtualMachine commands
export const enum VMCommand {
  Version = 1,
  ClassesBySignature = 2,
  AllClasses = 3,
  AllThreads = 4,
  TopLevelThreadGroups = 5,
  Dispose = 6,
  IDSizes = 7,
  Suspend = 8,
  Resume = 9,
  Exit = 10,
  CreateString = 11,
  Capabilities = 12,
  ClassPaths = 13,
  DisposeObjects = 14,
  HoldEvents = 15,
  ReleaseEvents = 16,
  CapabilitiesNew = 17,
  RedefineClasses = 18,
  SetDefaultStratum = 19,
  AllClassesWithGeneric = 20,
  InstanceCounts = 21,
  AllModules = 22,
}

// ReferenceType commands
export const enum ReferenceTypeCommand {
  Signature = 1,
  ClassLoader = 2,
  Modifiers = 3,
  Fields = 4,
  Methods = 5,
  GetValues = 6,
  SourceFile = 7,
  NestedTypes = 8,
  Status = 9,
  Interfaces = 10,
  ClassObject = 11,
  SourceDebugExtension = 12,
  SignatureWithGeneric = 13,
  FieldsWithGeneric = 14,
  MethodsWithGeneric = 15,
  Instances = 16,
  ClassFileVersion = 17,
  ConstantPool = 18,
  Module = 19,
}

// Method commands
export const enum MethodCommand {
  LineTable = 1,
  VariableTable = 2,
  Bytecodes = 3,
  IsObsolete = 4,
  VariableTableWithGeneric = 5,
}

// ThreadReference commands
export const enum ThreadCommand {
  Name = 1,
  Suspend = 2,
  Resume = 3,
  Status = 4,
  ThreadGroup = 5,
  Frames = 6,
  FrameCount = 7,
  OwnedMonitors = 8,
  CurrentContendedMonitor = 9,
  Stop = 10,
  Interrupt = 11,
  SuspendCount = 12,
  OwnedMonitorsStackDepthInfo = 13,
  ForceEarlyReturn = 14,
}

// StackFrame commands
export const enum StackFrameCommand {
  GetValues = 1,
  SetValues = 2,
  ThisObject = 3,
  PopFrames = 4,
}

// EventRequest commands
export const enum EventRequestCommand {
  Set = 1,
  Clear = 2,
  ClearAllBreakpoints = 3,
}

// StringReference commands
export const enum StringReferenceCommand {
  Value = 1,
}

// ObjectReference commands
export const enum ObjectReferenceCommand {
  ReferenceType = 1,
  GetValues = 2,
  SetValues = 3,
  MonitorInfo = 5,
  InvokeMethod = 6,
  DisableCollection = 7,
  EnableCollection = 8,
  IsCollected = 9,
  ReferringObjects = 10,
}

// ArrayReference commands
export const enum ArrayReferenceCommand {
  Length = 1,
  GetValues = 2,
  SetValues = 3,
}

// Event kinds
export const enum EventKind {
  SingleStep = 1,
  Breakpoint = 2,
  FramePop = 3,
  Exception = 4,
  UserDefined = 5,
  ThreadStart = 6,
  ThreadDeath = 7,
  ClassPrepare = 8,
  ClassUnload = 9,
  ClassLoad = 10,
  FieldAccess = 20,
  FieldModification = 21,
  ExceptionCatch = 30,
  MethodEntry = 40,
  MethodExit = 41,
  MethodExitWithReturnValue = 42,
  MonitorContendedEnter = 43,
  MonitorContendedEntered = 44,
  MonitorWait = 45,
  MonitorWaited = 46,
  VMStart = 90,
  VMDeath = 99,
}

// Suspend policy
export const enum SuspendPolicy {
  None = 0,
  EventThread = 1,
  All = 2,
}

// Step size
export const enum StepSize {
  Min = 0,
  Line = 1,
}

// Step depth
export const enum StepDepth {
  Into = 0,
  Over = 1,
  Out = 2,
}

// Type tags
export const enum TypeTag {
  Class = 1,
  Interface = 2,
  Array = 3,
}

// Tag values for primitive/object types
export const enum Tag {
  Array = 91, // '['
  Byte = 66, // 'B'
  Char = 67, // 'C'
  Object = 76, // 'L'
  Float = 70, // 'F'
  Double = 68, // 'D'
  Int = 73, // 'I'
  Long = 74, // 'J'
  Short = 83, // 'S'
  Void = 86, // 'V'
  Boolean = 90, // 'Z'
  String = 115, // 's'
  Thread = 116, // 't'
  ThreadGroup = 103, // 'g'
  ClassLoader = 108, // 'l'
  ClassObject = 99, // 'c'
  Null = 110, // 'n'
}

// Thread status
export const enum ThreadStatus {
  Zombie = 0,
  Running = 1,
  Sleeping = 2,
  Monitor = 3,
  Wait = 4,
}

// Suspend status
export const enum SuspendStatus {
  Suspended = 1,
}

// Event modifier kinds
export const enum ModKind {
  Count = 1,
  Conditional = 2,
  ThreadOnly = 3,
  ClassOnly = 4,
  ClassMatch = 5,
  ClassExclude = 6,
  LocationOnly = 7,
  ExceptionOnly = 8,
  FieldOnly = 9,
  Step = 10,
  InstanceOnly = 11,
  SourceNameMatch = 12,
}

// JDWP error codes
export const enum JDWPError {
  None = 0,
  InvalidThread = 10,
  InvalidThreadGroup = 11,
  InvalidPriority = 12,
  ThreadNotSuspended = 13,
  ThreadSuspended = 14,
  ThreadNotAlive = 15,
  InvalidObject = 20,
  InvalidClass = 21,
  ClassNotPrepared = 22,
  InvalidMethodid = 23,
  InvalidLocation = 24,
  InvalidFieldid = 25,
  InvalidFrameid = 30,
  NoMoreFrames = 31,
  OpaqueFrame = 32,
  NotCurrentFrame = 33,
  TypeMismatch = 34,
  InvalidSlot = 35,
  Duplicate = 40,
  NotFound = 41,
  InvalidMonitor = 50,
  NotMonitorOwner = 51,
  Interrupt = 52,
  InvalidClassFormat = 60,
  CircularClassDefinition = 61,
  FailsVerification = 62,
  AddMethodNotImplemented = 63,
  SchemaChangeNotImplemented = 64,
  InvalidTypestate = 65,
  HierarchyChangeNotImplemented = 66,
  DeleteMethodNotImplemented = 67,
  UnsupportedVersion = 68,
  NamesMismatch = 69,
  ClassModifiersChangeNotImplemented = 70,
  MethodModifiersChangeNotImplemented = 71,
  NotImplemented = 99,
  NullPointer = 100,
  AbsentInformation = 101,
  InvalidEventType = 102,
  IllegalArgument = 103,
  OutOfMemory = 110,
  AccessDenied = 111,
  VmDead = 112,
  Internal = 113,
  UnattachedThread = 115,
  InvalidTag = 500,
  AlreadyInvoking = 502,
  InvalidIndex = 503,
  InvalidLength = 504,
  InvalidString = 506,
  InvalidClassLoader = 507,
  InvalidArray = 508,
  TransportLoad = 509,
  TransportInit = 510,
  NativeMethod = 511,
  InvalidCount = 512,
}
