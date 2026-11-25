using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]

// This host-owned helper is compiled during preparation, never at runtime.
// Each invocation reads the current filesystem security descriptor. It has no
// permission cache, shell interpreter, or arbitrary command API.
internal static class AthenaWindowsPrivateStorage
{
    private const string Success = "ATHENA_PRIVATE_STORAGE_OK";
    private const string Version = "athena-windows-private-storage/1 .NETFramework/4.8";
    private const int MaxPathCharacters = 32767;

    private sealed class RejectedStorage : Exception
    {
        internal readonly string Reason;
        internal RejectedStorage(string reason) { Reason = reason; }
    }

    private static bool DriveRoot(string value)
    {
        return value.Length >= 3 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z'))
            && value[1] == ':' && (value[2] == '\\' || value[2] == '/');
    }

    private static bool UncRoot(string value)
    {
        var parts = value.Split(new[] { '\\', '/' }, StringSplitOptions.None);
        return parts.Length >= 2 && parts[0].Length != 0 && parts[1].Length != 0
            && parts[0] != "." && parts[0] != "?" && parts[0] != ".." && parts[1] != "." && parts[1] != "..";
    }

    private static bool AbsolutePath(string value)
    {
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return UncRoot(value.Substring(8));
        if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) return DriveRoot(value.Substring(4));
        if (value.StartsWith(@"\\", StringComparison.Ordinal)) return UncRoot(value.Substring(2));
        return DriveRoot(value);
    }

    private static string ReadPath()
    {
        var path = new StringBuilder();
        var buffer = new char[1024];
        int count;
        while ((count = Console.In.Read(buffer, 0, buffer.Length)) != 0)
        {
            if (path.Length + count > MaxPathCharacters) throw new RejectedStorage("invalid_path");
            path.Append(buffer, 0, count);
        }
        var value = path.ToString();
        // IsPathRooted alone accepts C:relative and \current-drive-relative.
        // Require a complete drive root or UNC/device root independently of Node.
        if (value.Length == 0 || value.IndexOf('\0') >= 0 || !AbsolutePath(value)
            || !Path.IsPathRooted(value)) throw new RejectedStorage("invalid_path");
        return value;
    }

    private static bool IsDirectory(string path)
    {
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new RejectedStorage("reparse_point");
        return (attributes & FileAttributes.Directory) != 0;
    }

    private static void Protect(string path, bool directory, SecurityIdentifier owner)
    {
        FileSystemSecurity acl = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
        var inheritance = directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
        acl.SetOwner(owner);
        acl.SetAccessRuleProtection(true, false);
        foreach (var principal in new[] { owner, new SecurityIdentifier("S-1-5-18"), new SecurityIdentifier("S-1-5-32-544") })
        {
            acl.AddAccessRule(new FileSystemAccessRule(principal, FileSystemRights.FullControl,
                inheritance, PropagationFlags.None, AccessControlType.Allow));
        }
        if (directory) Directory.SetAccessControl(path, (DirectorySecurity)acl);
        else File.SetAccessControl(path, (FileSecurity)acl);
    }

    private static void Check(string path, bool directory, SecurityIdentifier owner)
    {
        var sections = AccessControlSections.Owner | AccessControlSections.Access;
        FileSystemSecurity acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(path, sections)
            : File.GetAccessControl(path, sections);
        if (!owner.Equals(acl.GetOwner(typeof(SecurityIdentifier)))) throw new RejectedStorage("unexpected_owner");
        var system = new SecurityIdentifier("S-1-5-18");
        var administrators = new SecurityIdentifier("S-1-5-32-544");
        FileSystemRights ownerAccess = 0;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            var principal = rule.IdentityReference;
            if (rule.AccessControlType == AccessControlType.Allow)
            {
                if (!owner.Equals(principal) && !system.Equals(principal) && !administrators.Equals(principal))
                    throw new RejectedStorage("external_access");
                if (owner.Equals(principal)) ownerAccess |= rule.FileSystemRights;
            }
            else if (owner.Equals(principal)) throw new RejectedStorage("owner_denied");
        }
        if ((ownerAccess & FileSystemRights.FullControl) != FileSystemRights.FullControl)
            throw new RejectedStorage("missing_owner_access");
        // Refuse a path replaced with a reparse point or a different kind while
        // its security descriptor was being inspected.
        if (IsDirectory(path) != directory) throw new RejectedStorage("changed_kind");
    }

    private static int Main(string[] arguments)
    {
        try
        {
            if (arguments.Length == 1 && arguments[0] == "--version")
            {
                Console.Out.Write(Version);
                return 0;
            }
            if (arguments.Length != 1 || (arguments[0] != "check" && arguments[0] != "protect"))
                throw new RejectedStorage("invalid_operation");
            Console.InputEncoding = new UTF8Encoding(false, true);
            var path = ReadPath();
            var directory = IsDirectory(path);
            using (var identity = WindowsIdentity.GetCurrent())
            {
                var owner = identity.User;
                if (owner == null) throw new RejectedStorage("missing_identity");
                if (arguments[0] == "protect") Protect(path, directory, owner);
                Check(path, directory, owner);
            }
            Console.Out.Write(Success);
            return 0;
        }
        catch (RejectedStorage error)
        {
            Console.Error.Write("ATHENA_PRIVATE_STORAGE_REJECTED:" + error.Reason);
            return 1;
        }
        catch (Exception)
        {
            // Never disclose user paths or security descriptor contents.
            Console.Error.Write("ATHENA_PRIVATE_STORAGE_REJECTED:system_error");
            return 1;
        }
    }
}
