@echo off
echo =====================================================
echo   🚀  正在启动本地旅行推荐Web服务...
echo   打开浏览器访问:  http://localhost:5500
echo =====================================================

REM 如果用户没有 python，会提示安装
python -V >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    echo ❌ 未检测到Python，请先安装 https://www.python.org/
    pause
    exit
)

python -m http.server 5500
pause
