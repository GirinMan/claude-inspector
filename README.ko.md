<div align="center">

# Claude Inspector

**Claude Code가 API에 실제로 무엇을 보내는지 확인하세요.**

Claude Code CLI 트래픽을 실시간으로 가로채<br>
5가지 프롬프트 증강 메커니즘을 모두 시각화하는 MITM 프록시.

[설치](#설치) · [배울 수 있는 것들](#배울-수-있는-것들) · [프록시 모드](#프록시-모드) · [동작 원리](#동작-원리)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/kangraemin/claude-inspector)](https://github.com/kangraemin/claude-inspector/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black)](https://github.com/kangraemin/claude-inspector/releases/latest)

[English](README.md) | **한국어**

</div>

---

<p align="center">
  <img src="public/screenshots/proxy-request-en.png" width="100%" alt="Proxy — CLAUDE.md Global/Local 섹션 칩과 인라인 텍스트 하이라이트가 표시된 Request 뷰" />
</p>

<p align="center">
  <img src="public/screenshots/proxy-analysis-en.png" width="100%" alt="Proxy — 5가지 메커니즘을 자동 감지하고 섹션 내용을 보여주는 Analysis 뷰" />
</p>

## 배울 수 있는 것들

아래 내용은 모두 **실제 캡처된 트래픽**에서 발견한 것입니다. Claude Code가 감추고 있는 것을 확인하세요.

### 1. CLAUDE.md는 매 요청마다 주입된다

`hello`를 입력하면, Claude Code는 메시지 앞에 **~12KB**를 자동으로 추가합니다:

| 블록 | 내용 | 크기 |
|------|------|------|
| `content[0]` | 사용 가능한 스킬 목록 | ~2KB |
| `content[1]` | CLAUDE.md + rules + memory | **~10KB** |
| `content[2]` | 실제로 입력한 내용 | 수 바이트 |

**주입 순서:** 글로벌 CLAUDE.md → 글로벌 rules → 프로젝트 CLAUDE.md → Memory

이 ~12KB 페이로드는 **매 요청마다** 재전송됩니다. 500줄짜리 CLAUDE.md는 모든 API 호출에서 조용히 토큰을 소모합니다. 간결하게 유지하세요.

### 2. MCP 도구는 지연 로드된다 — `tools[]`가 늘어나는 것을 확인하세요

빌트인 도구(27개)는 매 요청마다 전체 JSON 스키마를 전송합니다. MCP 도구는 그렇지 않습니다 — 처음에는 **이름만** 존재합니다.

**실시간으로 개수가 변하는 것을 확인하세요:**

| 단계 | 발생하는 일 | `tools[]` 개수 |
|------|------------|---------------|
| 초기 요청 | 27개 빌트인 도구 로드 | **27** |
| 모델이 `ToolSearch("context7")` 호출 | 2개 MCP 도구 전체 스키마 반환 | **29** |
| 모델이 `ToolSearch("til")` 호출 | 6개 MCP 도구 스키마 추가 | **35** |

사용하지 않는 MCP 도구는 토큰을 소비하지 않습니다. Inspector로 모델이 필요한 도구를 발견할 때 `tools[]`가 늘어나는 것을 확인할 수 있습니다.

### 3. 이미지는 base64로 인라인 인코딩된다 — multipart가 아님

Claude Code가 스크린샷이나 이미지 파일을 읽을 때, multipart form data를 사용하지 않습니다. 이미지는 **base64로 인코딩되어 JSON 본문에 직접 포함**됩니다:

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "iVBORw0KGgo..."
  }
}
```

스크린샷 하나가 요청 페이로드에 **수백 KB**를 추가할 수 있습니다. Inspector로 정확한 크기를 확인할 수 있습니다.

### 4. Skill ≠ Command — 완전히 다른 주입 경로

`/something`을 입력하면 세 가지 완전히 다른 메커니즘 중 하나가 작동합니다:

| | 로컬 커맨드 | 사용자 스킬 | 어시스턴트 스킬 |
|---|---|---|---|
| **예시** | `/mcp`, `/clear` | `/commit` | `Skill("finish")` |
| **트리거** | 사용자 | 사용자 | 모델 |
| **주입** | `<local-command-stdout>` | user msg에 전체 프롬프트 | `tool_use` → `tool_result` |
| **모델에 전달** | 결과만 | 전체 프롬프트 | 전체 프롬프트 |

**커맨드**는 로컬에서 실행되어 결과만 전달합니다. **스킬**은 프롬프트 전체를 주입하며 — 세션이 끝날 때까지 **이후 모든 요청에 남습니다**.

### 5. 이전 메시지가 계속 쌓인다 — `/clear`를 자주 사용하세요

Claude Code는 매 요청마다 `messages[]` 배열 **전체**를 재전송합니다:

```json
{
  "messages": [
    {"role": "user",      "content": [/* ~12KB CLAUDE.md */ , "hello"]},
    {"role": "assistant", "content": [/* tool_use, thinking, response */]},
    {"role": "user",      "content": [/* ~12KB CLAUDE.md */ , "fix the bug"]},
    {"role": "assistant", "content": [/* tool_use, thinking, response */]},
    // ... 30턴 = CLAUDE.md 30개 복사본 + 모든 응답
  ]
}
```

| 턴 수 | 대략적인 페이로드 크기 |
|-------|---------------------|
| 1 | ~15KB |
| 10 | ~150KB |
| 30 | ~400KB+ |

대부분은 더 이상 필요 없는 이전 대화입니다. `/clear`를 실행하면 컨텍스트가 초기화되고 누적된 무게가 사라집니다. 자주 정리하세요.

### 6. 서브 에이전트는 완전히 격리된 컨텍스트에서 실행된다

Claude Code가 서브 에이전트를 생성하면(`Agent` 도구 사용), **완전히 별도의 API 호출**이 만들어집니다. 부모와 서브 에이전트는 완전히 다른 `messages[]`를 가집니다:

| | 부모 API 호출 | 서브 에이전트 API 호출 |
|---|---|---|
| **`messages[]`** | 전체 대화 이력 (모든 턴) | 작업 프롬프트만 — **부모 이력 없음** |
| **CLAUDE.md** | 포함됨 | 포함됨 (독립적으로) |
| **tools[]** | 로드된 모든 도구 | 새로운 세트 |
| **컨텍스트** | 누적됨 | 0에서 시작 |

Inspector는 부모와 서브 에이전트 호출을 모두 캡처하므로, 각각이 무엇을 보는지 비교할 수 있습니다.

## 설치

### Homebrew (권장)

```bash
brew install --cask kangraemin/tap/claude-inspector && open -a "Claude Inspector"
```

### 직접 다운로드

[Releases](https://github.com/kangraemin/claude-inspector/releases/latest) 페이지에서 `.dmg`를 다운로드하세요.

| Mac (Apple Silicon) | Mac (Intel) |
|---|---|
| [Claude-Inspector-arm64.dmg](https://github.com/kangraemin/claude-inspector/releases/latest) | [Claude-Inspector-x64.dmg](https://github.com/kangraemin/claude-inspector/releases/latest) |

### 삭제

```bash
brew uninstall --cask claude-inspector
```

## 개발 환경

```bash
git clone https://github.com/kangraemin/claude-inspector.git
cd claude-inspector
npm install
npm start
```

## 프록시 모드

로컬 MITM 프록시를 통해 **실제** Claude Code CLI 트래픽을 인터셉트합니다.

```
Claude Code CLI  →  Inspector (localhost:9090)  →  api.anthropic.com
```

**1.** 앱에서 **Start Proxy** 클릭<br>
**2.** 프록시를 통해 Claude Code 실행:

```bash
ANTHROPIC_BASE_URL=http://localhost:9090 claude
```

**3.** 모든 API 요청/응답이 실시간으로 캡처됩니다.

## 기술 스택

| 레이어 | 기술 | 이유 |
|--------|------|------|
| **Electron** | 데스크탑 셸, main/renderer 간 IPC | 네이티브 macOS 타이틀바(`hiddenInset`), 코드 서명 + 공증된 DMG 배포 |
| **Vanilla JS** | 프레임워크 없음, 빌드 단계 없음 | 전체 UI가 단일 `index.html` — 번들러 없음, 트랜스파일러 없음, React 없음 |
| **Node `http`/`https`** | `localhost` MITM 프록시 | Claude Code ↔ Anthropic API 트래픽 인터셉트, SSE 스트림을 완전한 응답 객체로 재조립 |
| **highlight.js + marked** | 구문 강조 및 마크다운 | JSON 페이로드와 마크다운 콘텐츠를 인라인 렌더링 |

> **프라이버시**: 모든 트래픽은 `localhost`에서만 처리됩니다. `api.anthropic.com`으로 직접 전송되는 것 외에 어디에도 데이터를 보내지 않습니다.

## 라이선스

MIT
