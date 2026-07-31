# Architecture

## 목표

SNS Reader는 PC에서 실행되는 로컬 앱으로, 사용자가 지정한 SNS/블로그 계정의 글을 수집해 두 가지 결과물을 만듭니다.

- Obsidian용 Markdown Database
- 기간, 년도, 페이지 수 기준으로 나뉜 PDF 책

## 권장 기술 스택

- Shell: Electron
- UI: React + TypeScript + Vite
- Icons: lucide-react
- Storage: local JSON 설정 파일 (`data/runtime/app-settings.json`) + OS keychain 연동 예정
- Markdown: frontmatter + body markdown
- PDF: `pdfkit` 기반 직접 렌더링 (`vite.config.mts` dev API 안에서 생성)

## 실제 모듈 경계 (2026-07-31 기준)

원래 계획했던 `src/services/{collectors,obsidian,pdf,settings}` 분리 대신, 실제 구현은 아래 경계로 자리 잡았다.

```text
src/
  App.tsx              Main UI shell (single large component)
  settings/            Local settings defaults/storage/LLM provider config
  types/domain.ts       Shared domain types

tools/                  SNS collectors, dedupe, validate, LLM enrich, audit (Node CLI, run via npm scripts)

vite.config.mts          Dev API (/api/markdown-cards, /api/media, /api/settings) + PDF generation backend
```

`src/services/*` 경계로의 리팩터링은 아직 진행되지 않았다; 향후 Electron 프로덕션 연결(로드맵 Wave 6) 시점에 재검토가 필요하다.

## 수집 계층

SNS마다 인증과 접근 정책이 다르므로 플랫폼별 collector를 분리합니다.

- 공개 계정: 공개 URL 기반 읽기 우선
- 로그인 필요 계정: 사용자가 명시적으로 로그인 정보를 입력한 경우만 처리
- 비밀번호: 앱 설정 파일에 직접 저장하지 않고 OS 보안 저장소 사용
- 플랫폼 정책: 공식 API 또는 사용 가능한 export/archive 데이터 우선 검토
- 증분 업데이트("SNS Update")는 마지막으로 저장된 글의 발행일만 기준으로 하면 이미 저장된 글이 나중에 수정(이미지 추가 등)되어도 감지할 수 없으므로, 설정 가능한 며칠(`snsUpdateLookbackDays`, 기본 3일) 앞선 날짜부터 다시 확인하고 그 범위 안의 글은 이미 있어도 강제로 갱신한다
- 게시물 이미지는 플랫폼 웹페이지를 직접 파싱하는 대신, 링크 미리보기용 메타데이터(og:image 등)를 우선 사용한다 — 페이지 UI 변경에 훨씬 덜 취약하다

## Obsidian 저장 폴더 정책

기본 정책은 **SNS별 폴더 + YYYY-MM 월별 폴더 + 글별 assets 폴더**입니다.

이 구조를 기본값으로 두는 이유는 세 가지입니다.

- SNS별로 원본 출처가 명확하게 분리됩니다.
- 월별 폴더가 있어 글이 많아져도 Obsidian 탐색이 무겁지 않습니다.
- 각 글의 그림, 콜라주, 첨부 파일이 글 파일과 안정적으로 연결됩니다.

```text
ObsidianVault/
  SNS/
    facebook/
      2026-07/
        2026-07-22_1530_facebook_post-id.md
        assets/
          2026-07-22_1530_facebook_post-id/
            image-001.jpg
            image-002.jpg
            collage.jpg
            meta.json
    instagram/
      2026-07/
        2026-07-22_1821_instagram_post-id.md
        assets/
          2026-07-22_1821_instagram_post-id/
            image-001.jpg
            collage.jpg
    x/
      2026-07/
        2026-07-22_2104_x_post-id.md
        assets/
          2026-07-22_2104_x_post-id/
            image-001.jpg
    naver-blog/
      2026-07/
        2026-07-22_0900_naver-blog_post-id.md
        assets/
          2026-07-22_0900_naver-blog_post-id/
            image-001.jpg
```

## 파일 이름 규칙

Markdown 파일 이름은 아래 형식을 기본으로 합니다.

```text
YYYY-MM-DD_HHmm_platform_post-id.md
```

예시:

```text
2026-07-22_1530_instagram_Cx9ab12.md
```

제목을 파일명에 넣지 않는 이유는 제목이 없거나 너무 길거나 특수문자가 포함될 수 있기 때문입니다. 제목은 Markdown frontmatter와 본문에 저장합니다.

## Markdown 형식

각 글은 하나의 Markdown 파일이 됩니다.

```markdown
---
title: ""
date: "2026-07-22T15:30:00+09:00"
source: "https://..."
platform: "instagram"
account: "example"
mediaFolder: "assets/2026-07-22_1530_instagram_Cx9ab12"
tags:
  - 기록
  - SNS
---

# 제목

본문

## 그림

![그림 콜라주](assets/2026-07-22_1530_instagram_Cx9ab12/collage.jpg)

- [그림 1](assets/2026-07-22_1530_instagram_Cx9ab12/image-001.jpg)
- [그림 2](assets/2026-07-22_1530_instagram_Cx9ab12/image-002.jpg)

## 댓글

- 댓글 내용

## 요약

두 줄 요약
```

## 그림 저장 정책

각 글에 포함된 그림은 해당 글 전용 assets 폴더에 저장합니다.

```text
ObsidianVault/
  SNS/
    instagram/
      2026-07/
        2026-07-22_1530_instagram_Cx9ab12.md
        assets/
          2026-07-22_1530_instagram_Cx9ab12/
            image-001.jpg
            image-002.jpg
            image-003.jpg
            collage.jpg
            meta.json
```

그림 파일 규칙:

- 원본 순서대로 `image-001.jpg`, `image-002.jpg`처럼 저장합니다.
- 여러 장이면 `collage.jpg`를 생성해 Markdown 미리보기 대표 이미지로 사용합니다.
- 각 이미지를 클릭해 크게 볼 수 있도록 Markdown에는 원본 이미지 링크도 함께 기록합니다.
- `meta.json`에는 원본 URL, 다운로드 시각, 이미지 크기, 해시값을 저장해 중복 다운로드를 줄입니다.

## 저장 구조 옵션

설정에서는 아래 두 가지 구조를 선택할 수 있게 만들 예정입니다.

### 기본값: SNS별 + 월별

```text
SNS/
  instagram/
    2026-07/
      post.md
```

대부분의 사용에 가장 적합합니다.

### 대안: 월별 + SNS별

```text
SNS/
  2026-07/
    instagram/
      post.md
```

월 단위로 모든 SNS를 함께 보고 싶은 경우에 적합합니다.

첫 구현은 **SNS별 + YYYY-MM 월별 구조**로 진행합니다.

## PDF 생성 흐름

1. Obsidian Markdown 폴더 스캔
2. 날짜/frontmatter 기준 정렬
3. 선택 기준으로 책 단위 분할
4. 표지, 인포그래픽/요약, 게시글 페이지 생성
5. 각 게시글은 새 페이지에서 시작
6. PDF 파일로 출력
