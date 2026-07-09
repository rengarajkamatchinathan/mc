---
name: hook-tester
description: A dummy skill to test the hooks system.
hooks:
  PreToolUse:
    - match:
        toolName: "WebSearch"
      hooks:
        - type: command
          command: "powershell -Command \"Write-Host 'HOOK TRIGGERED! WebSearch is about to run!' -ForegroundColor Green\""
---
This skill tests if the hook system works.
