@echo off
chcp 65001 >nul
title Super Agent - 生产模式

:: ============================================================
::  Super Agent 生产环境一键启动脚本 (Windows)
::  自动检查/安装 PM2，构建项目，启动服务，配置开机自启
:: ============================================================

:: 处理子命令
if /i "%1"=="stop" goto :cmd_stop
if /i "%1"=="restart" goto :cmd_restart
if /i "%1"=="status" goto :cmd_status
if /i "%1"=="logs" goto :cmd_logs
if /i "%1"=="save" goto :cmd_save
if /i "%1"=="help" goto :cmd_help

:: ===== 默认：启动 =====
echo.
echo   ============================================
echo   =    Super Agent 生产模式一键启动          =
echo   ============================================
echo.

:: 切换到脚本所在目录（monorepo 根）
cd /d "%~dp0"

:: [1/6] 检查环境变量文件
echo [1/6] 检查环境配置...
if not exist ".env" (
    if exist ".env.example" (
        echo    .env 文件不存在，从模板创建...
        copy .env.example .env >nul
        echo    已创建 .env，请编辑填入 LLM_API_KEY 等必填项
        echo    生产环境必须设置：AUTH_ENABLED=true, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD
    ) else (
        echo    [错误] 未找到 .env 和 .env.example，无法继续
        pause
        exit /b 1
    )
)
:: 检查 SA_ENCRYPTION_KEY 是否已生成
findstr /C:"SA_ENCRYPTION_KEY=" .env | findstr /V /C:"SA_ENCRYPTION_KEY=$" /C:"SA_ENCRYPTION_KEY= " >nul 2>&1
if %errorlevel% neq 0 (
    echo    生成 SA_ENCRYPTION_KEY...
    for /f %%i in ('node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"') do (
        echo SA_ENCRYPTION_KEY=%%i>> .env
    )
    echo    SA_ENCRYPTION_KEY 已生成并写入 .env
)
echo    环境配置已就绪

:: [2/6] 检查 PM2
echo.
echo [2/6] 检查 PM2...
where pm2 >nul 2>&1
if %errorlevel% neq 0 (
    echo    PM2 未安装，正在安装...
    call npm i -g pm2
    if %errorlevel% neq 0 (
        echo    [错误] PM2 安装失败，请检查 Node.js 和 npm 环境
        pause
        exit /b 1
    )
    :: Windows 开机自启需要额外组件
    call npm i -g pm2-windows-startup
)
echo    PM2 已就绪

:: [3/6] 安装 Node.js 依赖
echo.
echo [3/6] 检查 Node.js 依赖...
if not exist "node_modules" (
    echo    node_modules 不存在，正在安装依赖...
    call pnpm install
    if %errorlevel% neq 0 (
        echo    [错误] 依赖安装失败，请检查网络或 pnpm 配置
        pause
        exit /b 1
    )
)
echo    Node.js 依赖已就绪

:: [4/6] 检查 Node.js 构建产物
echo.
echo [4/6] 检查构建产物...
if not exist "packages\api\dist\index.js" (
    echo    未找到构建产物，正在构建...
    call pnpm build
    if %errorlevel% neq 0 (
        echo    [错误] 构建失败，请检查代码错误
        pause
        exit /b 1
    )
)
echo    构建产物已就绪

:: [5/6] 检查 Python 微服务依赖（video-forge / IM 网关 / kb-parser）
echo.
echo [5/6] 检查 Python 微服务依赖...
set PY_READY=1
:: 检测 Python 3.11+
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo    [警告] 未检测到 Python，跳过 Python 微服务依赖检查
    echo    如需视频生成/IM 网关/文档解析功能，请安装 Python 3.11+ 后重试
    set PY_READY=0
)
if %PY_READY%==1 (
    for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PY_VER=%%v
    echo    Python %PY_VER% 已就绪

    :: 检查 video-forge 依赖
    if exist "services\video-forge\requirements.txt" (
        python -c "import fastapi" >nul 2>&1
        if %errorlevel% neq 0 (
            echo    安装 Video-Forge Python 依赖...
            python -m pip install -r services\video-forge\requirements.txt -q
            if %errorlevel% neq 0 (
                echo    [警告] Video-Forge 依赖安装失败，视频生成功能不可用
            ) else (
                echo    Video-Forge 依赖已就绪
            )
        ) else (
            echo    Video-Forge 依赖已就绪
        )
    )

    :: 检查 IM 网关依赖
    if exist "services\im-gateway\requirements.txt" (
        python -c "import fastapi" >nul 2>&1
        if %errorlevel% neq 0 (
            echo    安装 IM Gateway Python 依赖...
            python -m pip install -r services\im-gateway\requirements.txt -q
            if %errorlevel% neq 0 (
                echo    [警告] IM Gateway 依赖安装失败，飞书/钉钉/企微不可用
            ) else (
                echo    IM Gateway 依赖已就绪
            )
        ) else (
            echo    IM Gateway 依赖已就绪
        )
    )

    :: 检查 kb-parser 依赖
    if exist "services\kb-parser\requirements.txt" (
        python -c "import docling" >nul 2>&1
        if %errorlevel% neq 0 (
            echo    安装 KB-Parser Python 依赖...
            python -m pip install -r services\kb-parser\requirements.txt -q
            if %errorlevel% neq 0 (
                echo    [警告] KB-Parser 依赖安装失败，文档解析功能不可用
            ) else (
                echo    KB-Parser 依赖已就绪
            )
        ) else (
            echo    KB-Parser 依赖已就绪
        )
    )
)

:: [6/6] 启动 PM2
echo.
echo [6/6] 启动服务...
:: 先停掉旧实例（如果存在），避免端口冲突
call pm2 delete super-agent-api 2>nul
call pm2 delete super-agent-web 2>nul
call pm2 delete super-agent-gateway 2>nul
call pm2 delete super-agent-video-forge 2>nul
call pm2 start ecosystem.config.cjs --env production
call pm2 save

:: 配置开机自启
call pm2 startup
echo    开机自启已配置

:: 显示结果
echo.
echo   ============================================
echo   =    Super Agent 生产模式已启动！          =
echo   ============================================
echo.
echo    管理面板: http://localhost:3000
echo    API 服务:  http://localhost:3001
echo    IM 网关:   http://localhost:8642
echo.
echo    常用命令:
echo      start.bat status   - 查看服务状态
echo      start.bat logs     - 查看日志
echo      start.bat restart  - 重启所有服务
echo      start.bat stop     - 停止所有服务
echo      start.bat save     - 保存当前进程列表
echo      start.bat help     - 显示帮助
echo.
pause
exit /b 0

:: ===== 子命令 =====

:cmd_stop
echo 停止所有服务...
call pm2 stop ecosystem.config.cjs
call pm2 save
echo 已停止
goto :eof

:cmd_restart
echo 重启所有服务...
call pm2 restart ecosystem.config.cjs
echo 已重启
goto :eof

:cmd_status
call pm2 status
goto :eof

:cmd_logs
echo 查看日志 (Ctrl+C 退出)...
call pm2 logs
goto :eof

:cmd_save
call pm2 save
echo 进程列表已保存
goto :eof

:cmd_help
echo.
echo   Super Agent 生产环境管理脚本
echo.
echo   用法: start.bat [命令]
echo.
echo   命令:
echo     (无参数)  一键启动所有服务
echo     status    查看服务运行状态
echo     logs      实时查看日志
echo     restart   重启所有服务
echo     stop      停止所有服务
echo     save      保存当前进程列表
echo     help      显示此帮助
echo.
goto :eof
