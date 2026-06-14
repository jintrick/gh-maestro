#Requires -Version 5.1
<#
.SYNOPSIS
    gh-maestro one-time global installer
.DESCRIPTION
    Installs gh-maestro skills and setup scripts globally so that any project
    can start a session with /gh-maestro from claude or agy (inside wezterm).

    Run once. Re-run to update after pulling new versions.
#>

node "$PSScriptRoot\gh-maestro-install.js"
