param([Parameter(Mandatory=$true)][Int64]$Hwnd)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AnnotationPolicyProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect rect, int size);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
}
'@
$affinity = [uint32]0
$ok = [AnnotationPolicyProbe]::GetWindowDisplayAffinity([IntPtr]$Hwnd, [ref]$affinity)
$style = [AnnotationPolicyProbe]::GetWindowLongPtr([IntPtr]$Hwnd, -20).ToInt64()
[AnnotationPolicyProbe]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$outer = New-Object AnnotationPolicyProbe+Rect
$client = New-Object AnnotationPolicyProbe+Rect
$dwm = New-Object AnnotationPolicyProbe+Rect
$origin = New-Object AnnotationPolicyProbe+Point
[AnnotationPolicyProbe]::GetWindowRect([IntPtr]$Hwnd,[ref]$outer) | Out-Null
[AnnotationPolicyProbe]::GetClientRect([IntPtr]$Hwnd,[ref]$client) | Out-Null
[AnnotationPolicyProbe]::DwmGetWindowAttribute([IntPtr]$Hwnd,9,[ref]$dwm,16) | Out-Null
[AnnotationPolicyProbe]::ClientToScreen([IntPtr]$Hwnd,[ref]$origin) | Out-Null
@{ affinityRead=$ok; affinity=$affinity; mouseTransparent=($style -band 0x20) -ne 0; noActivate=($style -band 0x08000000) -ne 0;
outer=$outer;client=$client;dwm=$dwm;origin=$origin } | ConvertTo-Json -Compress
