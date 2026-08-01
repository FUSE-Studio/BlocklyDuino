@ echo OFF

REM Retired — kept only so muscle memory hits this message instead of the old
REM script. It used to `rmdir build /s /q` and repopulate from
REM blockly\apps\blocklyduino\, which is destructive: build\ is now the source
REM of truth and holds fixes that never existed upstream (Chrome 109+
REM Event.path polyfill, flyout click and pointer-events fixes, the sparki
REM toolbox category). It also copied blockly\*_compressed.js, which are not in
REM the repo, and ran a Closure build that cannot work — build.py is Python 2
REM only, closure-library is an unchecked-out submodule, and the Google API it
REM called is long gone.
REM
REM See build.sh and the Makefile header for the full story.

echo build.bat is retired and does nothing - it used to destroy build\.
echo.
echo   make dev            build and serve locally on :8080
echo   make index          regenerate build\index.html from src\
echo   make publish-dev    publish to the dev satellite CDN
echo   make publish-prod   publish to the prod satellite CDN
echo.
echo See the Makefile header for why blockly\ is no longer a build input.
exit /b 1
