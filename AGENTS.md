# SNS Reader Project Instructions

이 파일은 `C:\Claude\SNS-Reader` 프로젝트 전용 작업 기준입니다.

## Project Summary

SNS Reader는 Facebook, Instagram, X, Naver Blog 등 SNS/블로그 게시글을 읽어 Obsidian용 Markdown Database와 PDF 책 형태로 정리하는 PC 앱입니다.

## Mandatory Rules

- Code comments must be English only.
- User-facing UI text must be Korean.
- Inputs inside dialogs, modals, and bottom sheets must remain usable with small screens, large fonts, and keyboard-visible states.
- UI bug fixes must include regression checks for basic flows such as open, input focus, save, and cancel.
- Do not store raw passwords in plaintext project files.

## Local Project Workflow

- Keep `memory-bank/active-context.md` lean and current.
- Append temporary findings to `memory-bank/CACHE.md` during work.
- Flush reusable findings into `memory-bank/knowledge/` after each completed wave.

## Technology Direction

- Desktop app shell: Electron.
- Frontend: React + TypeScript + Vite.
- UI style: minimal, icon-forward, Korean labels.
- Local exports: Obsidian-compatible Markdown files, media folders, generated PDF files.

## Data Boundaries

- SNS collectors should be isolated under a future `src/services/collectors/` boundary.
- Obsidian export logic should be isolated under a future `src/services/obsidian/` boundary.
- PDF generation logic should be isolated under a future `src/services/pdf/` boundary.
- Login credentials must be handled through secure local storage or OS keychain in a future implementation.
