; 安装 Cove Server 时，自动静默安装 Visual C++ 运行库
; mediasoup 的原生 worker 需要它，否则会报 0xc000007b

!macro customInstall
  DetailPrint "正在安装 Visual C++ 运行库（mediasoup 依赖）..."
  ; vc_redist 通过 extraResources 被放到 resources 目录
  ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart' $0
  DetailPrint "Visual C++ 运行库安装完成 (code=$0)"
!macroend
