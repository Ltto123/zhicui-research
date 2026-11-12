# This helper only receives a disposable recovery-package copy. Callers must keep
# the originals until the returned Recycle Bin item and all its hashes are verified.
# There is deliberately no permanent-delete fallback or Shell UI automation.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($null -eq $payload -or $payload.directory -isnot [string] -or $payload.allowedRoot -isnot [string]) {
        throw 'Expected directory and allowedRoot in JSON stdin.'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Zhicui.Recycle {
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem {
        [PreserveSig] int BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        [PreserveSig] int GetParent(out IShellItem parent);
        [PreserveSig] int GetDisplayName(uint kind, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare(IShellItem item, uint hint, out int order);
    }

    [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOperation {
        [PreserveSig] int Advise(IFileOperationProgressSink sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOperationFlags(uint flags);
        [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        [PreserveSig] int SetProgressDialog(IntPtr dialog);
        [PreserveSig] int SetProperties(IntPtr properties);
        [PreserveSig] int SetOwnerWindow(IntPtr owner);
        [PreserveSig] int ApplyPropertiesToItem(IShellItem item);
        [PreserveSig] int ApplyPropertiesToItems(IntPtr items);
        [PreserveSig] int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
        [PreserveSig] int RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int MoveItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
        [PreserveSig] int MoveItems(IntPtr items, IShellItem destination);
        [PreserveSig] int CopyItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
        [PreserveSig] int CopyItems(IntPtr items, IShellItem destination);
        [PreserveSig] int DeleteItem(IShellItem item, IFileOperationProgressSink sink);
        [PreserveSig] int DeleteItems(IntPtr items);
        [PreserveSig] int NewItem(IShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IFileOperationProgressSink sink);
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }

    [ComVisible(true), Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOperationProgressSink {
        [PreserveSig] int StartOperations();
        [PreserveSig] int FinishOperations(int result);
        [PreserveSig] int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem created);
        [PreserveSig] int PreMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem created);
        [PreserveSig] int PreCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem created);
        [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
        [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem created);
        [PreserveSig] int PreNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, uint attributes, int result, IShellItem created);
        [PreserveSig] int UpdateProgress(uint total, uint completed);
        [PreserveSig] int ResetTimer();
        [PreserveSig] int PauseTimer();
        [PreserveSig] int ResumeTimer();
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct FileInformation {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    public static class Native {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        public static extern int SHCreateItemFromParsingName(string name, IntPtr context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetFileAttributesW(string name);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);

        public static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
        public static string FileSystemPath(IShellItem item) {
            if (item == null) throw new IOException("The Shell did not return a Recycle Bin item.");
            IntPtr value = IntPtr.Zero;
            try {
                Check(item.GetDisplayName(0x80058000, out value)); // SIGDN_FILESYSPATH
                string result = Marshal.PtrToStringUni(value);
                if (String.IsNullOrEmpty(result)) throw new IOException("The Shell item has no readable filesystem path.");
                return CleanPath(result);
            } finally { if (value != IntPtr.Zero) Marshal.FreeCoTaskMem(value); }
        }
        public static string CleanPath(string value) {
            if (String.IsNullOrEmpty(value) || !Regex.IsMatch(value, @"^[A-Za-z]:[\\/]")) throw new IOException("Only absolute local drive paths are accepted.");
            if (value.Substring(2).Contains(":")) throw new IOException("Alternate streams are not accepted.");
            foreach (string part in value.Substring(3).Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries)) {
                if (part == "." || part == ".." || Regex.IsMatch(part, "[<>\"|?*\\x00-\\x1f]|[. ]$") || Regex.IsMatch(part, @"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", RegexOptions.IgnoreCase)) throw new IOException("Unsafe Windows path segment.");
            }
            return Path.GetFullPath(value).TrimEnd('\\');
        }
        public static uint OrdinaryAttributes(string value) {
            uint attributes = GetFileAttributesW(value);
            if (attributes == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((attributes & 0x400) != 0) throw new IOException("Reparse points, junctions and symbolic links are not accepted.");
            return attributes;
        }
        public static void Validate(string directory, string root) {
            directory = CleanPath(directory); root = CleanPath(root);
            if (root.Length <= 3 || !directory.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase)) throw new IOException("Package is outside the allowed root.");
            if (Identity(root) != Identity(directory.Substring(0, root.Length))) throw new IOException("The package ancestor differs from the allowed root.");
            if ((OrdinaryAttributes(directory) & 0x10) == 0) throw new IOException("The recovery package must be a directory.");
            for (string current = directory; current != null; current = Path.GetDirectoryName(current)) {
                OrdinaryAttributes(current);
                if (current.Length <= 3) break;
            }
            Stack<string> pending = new Stack<string>();
            pending.Push(directory);
            while (pending.Count != 0) {
                foreach (string entry in Directory.EnumerateFileSystemEntries(pending.Pop())) {
                    CleanPath(entry);
                    if ((OrdinaryAttributes(entry) & 0x10) != 0) pending.Push(entry);
                }
            }
        }
        public static string Identity(string value) {
            using (SafeFileHandle handle = CreateFileW(value, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                FileInformation information;
                if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if ((information.Attributes & 0x400) != 0) throw new IOException("Package identity is a reparse point.");
                return information.VolumeSerial + ":" + information.IndexHigh + ":" + information.IndexLow;
            }
        }
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class ProgressSink : IFileOperationProgressSink {
        private const int Abort = unchecked((int)0x80004004);
        private readonly string source, root, identity;
        public string RecycledPath, Failure;
        public int BeforeCount, AfterCount;
        public ProgressSink(string source, string root) { this.source = source; this.root = root; identity = Native.Identity(source); }
        public int PreDeleteItem(uint flags, IShellItem item) {
            try {
                if (++BeforeCount != 1 || (flags & 0x80) == 0 || !String.Equals(Native.FileSystemPath(item), source, StringComparison.OrdinalIgnoreCase)) throw new IOException("Delete callback did not identify exactly the recyclable package.");
                Native.Validate(source, root);
                if (Native.Identity(source) != identity) throw new IOException("The recovery package identity changed.");
                return 0;
            } catch (Exception error) { Failure = error.Message; return Abort; }
        }
        public int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem created) {
            try {
                if (++AfterCount != 1 || BeforeCount != 1 || result < 0 || created == null || !String.Equals(Native.FileSystemPath(item), source, StringComparison.OrdinalIgnoreCase)) throw new IOException("The Shell did not confirm a recoverable deletion.");
                string destination = Native.FileSystemPath(created);
                string volume = Path.GetPathRoot(source);
                if (!destination.StartsWith(volume, StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(destination.Substring(volume.Length), @"^\$Recycle\.Bin\\S-\d+(-\d+)+\\\$R[^\\]+$", RegexOptions.IgnoreCase)) throw new IOException("The receipt is not a Recycle Bin entry on the source volume.");
                Native.Validate(destination, Path.Combine(volume, "$Recycle.Bin"));
                RecycledPath = destination;
                return 0;
            } catch (Exception error) { Failure = error.Message; return Abort; }
        }
        public int StartOperations() { return 0; }
        public int FinishOperations(int result) { if (result < 0) Failure = "The Shell reported a failed operation."; return 0; }
        public int PreRenameItem(uint flags, IShellItem item, string name) { return Abort; }
        public int PostRenameItem(uint flags, IShellItem item, string name, int result, IShellItem created) { return Abort; }
        public int PreMoveItem(uint flags, IShellItem item, IShellItem destination, string name) { return Abort; }
        public int PostMoveItem(uint flags, IShellItem item, IShellItem destination, string name, int result, IShellItem created) { return Abort; }
        public int PreCopyItem(uint flags, IShellItem item, IShellItem destination, string name) { return Abort; }
        public int PostCopyItem(uint flags, IShellItem item, IShellItem destination, string name, int result, IShellItem created) { return Abort; }
        public int PreNewItem(uint flags, IShellItem destination, string name) { return Abort; }
        public int PostNewItem(uint flags, IShellItem destination, string name, string template, uint attributes, int result, IShellItem created) { return Abort; }
        public int UpdateProgress(uint total, uint completed) { return 0; }
        public int ResetTimer() { return 0; }
        public int PauseTimer() { return 0; }
        public int ResumeTimer() { return 0; }
    }

    public static class Operation {
        public static string Recycle(string directory, string root) {
            if (System.Threading.Thread.CurrentThread.GetApartmentState() != System.Threading.ApartmentState.STA) throw new InvalidOperationException("The recycler requires STA.");
            directory = Native.CleanPath(directory); root = Native.CleanPath(root);
            Native.Validate(directory, root);
            IShellItem item = null;
            IFileOperation operation = null;
            try {
                Guid iid = typeof(IShellItem).GUID;
                Native.Check(Native.SHCreateItemFromParsingName(directory, IntPtr.Zero, ref iid, out item));
                operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
                // RECYCLEONDELETE | EARLYFAILURE | NOERRORUI | SILENT | NOCONFIRMATION.
                // A recycle flag is a request, not proof. Only PostDeleteItem's
                // non-null newly-created Shell item constitutes a receipt.
                Native.Check(operation.SetOperationFlags(0x00080000 | 0x00100000 | 0x00000400 | 0x00000004 | 0x00000010));
                ProgressSink sink = new ProgressSink(directory, root);
                Native.Check(operation.DeleteItem(item, sink));
                int result = operation.PerformOperations();
                bool aborted;
                Native.Check(operation.GetAnyOperationsAborted(out aborted));
                GC.KeepAlive(sink);
                if (result < 0 || aborted || sink.Failure != null || sink.BeforeCount != 1 || sink.AfterCount != 1 || String.IsNullOrEmpty(sink.RecycledPath)) throw new IOException("Recycle not confirmed: " + (sink.Failure ?? "operation aborted or no receipt"));
                if (Directory.Exists(directory) || File.Exists(directory)) throw new IOException("The disposable package still exists at its source path.");
                Native.Validate(sink.RecycledPath, Path.Combine(Path.GetPathRoot(directory), "$Recycle.Bin"));
                return sink.RecycledPath;
            } finally {
                if (operation != null) Marshal.FinalReleaseComObject(operation);
                if (item != null) Marshal.FinalReleaseComObject(item);
            }
        }
    }
}
'@
    $recycledPath = [Zhicui.Recycle.Operation]::Recycle($payload.directory, $payload.allowedRoot)
    [Console]::Out.WriteLine((@{ version = 1; sourcePath = $payload.directory; recycledPath = $recycledPath; recycleConfirmed = $true; aborted = $false } | ConvertTo-Json -Compress))
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
