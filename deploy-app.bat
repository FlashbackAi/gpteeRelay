@echo off
REM GpteeRelay Application Deployment Script (Windows)
REM Use this for deploying code changes (not infrastructure changes)

setlocal

set ECR_URI=144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay
set CLUSTER=gptee-cluster
set SERVICE=gptee-service
set REGION=us-east-1

echo ==========================================
echo GpteeRelay Application Deployment
echo ==========================================
echo.

REM Step 1: Build TypeScript
echo Building TypeScript...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo Error: TypeScript build failed
    exit /b 1
)
echo Build complete
echo.

REM Step 2: Build Docker image
echo Building Docker image...
docker build -t gptee-relay:latest .
if %ERRORLEVEL% NEQ 0 (
    echo Error: Docker build failed
    exit /b 1
)
echo Docker image built
echo.

REM Step 3: Login to ECR
echo Logging into ECR...
for /f "tokens=*" %%i in ('aws ecr get-login-password --region %REGION%') do set ECR_PASSWORD=%%i
echo %ECR_PASSWORD% | docker login --username AWS --password-stdin %ECR_URI%
if %ERRORLEVEL% NEQ 0 (
    echo Error: ECR login failed
    exit /b 1
)
echo ECR login successful
echo.

REM Step 4: Tag and push
echo Pushing to ECR...
docker tag gptee-relay:latest %ECR_URI%:latest
docker push %ECR_URI%:latest
if %ERRORLEVEL% NEQ 0 (
    echo Error: Docker push failed
    exit /b 1
)
echo Image pushed to ECR
echo.

REM Step 5: Deploy to ECS
echo Deploying to ECS...
aws ecs update-service --cluster %CLUSTER% --service %SERVICE% --force-new-deployment --region %REGION% >nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: ECS deployment failed
    exit /b 1
)
echo Deployment initiated
echo.

echo ==========================================
echo Deployment Summary
echo ==========================================
echo Image: %ECR_URI%:latest
echo Cluster: %CLUSTER%
echo Service: %SERVICE%
echo.
echo Monitor deployment:
echo   aws ecs describe-services --cluster %CLUSTER% --services %SERVICE% --region %REGION%
echo.
echo View logs:
echo   aws logs tail /ecs/gptee-relay --follow --region %REGION%
echo.

endlocal
