@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo Uploading to GitHub...
git add index.html
git commit -m "Update"
git push
echo.
echo === Upload complete! ===
pause
