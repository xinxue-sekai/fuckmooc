Option Explicit
' Launch the GUI without a console window: 0 = hidden, False = do not wait
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder(dir & "\data")
sh.CurrentDirectory = dir
sh.Run "cmd /c node gui.js > data\gui-stdout.log 2>&1", 0, False
