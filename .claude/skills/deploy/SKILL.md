---
name: deploy
description: Claude Inspector macOS 배포 스킬. 빌드(코드사이닝+공증) → GitHub Release → Homebrew cask 업데이트 전체 플로우. '배포', 'deploy', '릴리즈', 'release', '배포해', '출시' 등 배포 관련 요청 시 반드시 이 스킬을 사용한다.
---

# Claude Inspector 배포

## 전제조건
- `.env` 파일에 `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` 설정
- `gh` CLI 로그인 상태 (`gh auth status`)
- 미커밋 변경사항 없음

---

## Step 1: 버전 확인

```bash
node -e "console.log(require('./package.json').version)"
```

사용자가 버전을 지정했으면 `package.json`의 `version` 필드를 해당 버전으로 수정 후 커밋+푸시:

```bash
git add package.json
git commit -m "chore: 버전 X.X.X로 설정"
git push
```

---

## Step 2: 빌드 (코드사이닝 + 공증 포함)

```bash
source .env && npm run dist:mac
```

`predist` 스크립트가 `public/build-info.json`을 자동 갱신하고,
`afterSign` 훅(`scripts/notarize.js`)이 공증까지 자동 처리한다.
완료까지 5~10분 소요. 중간에 Apple 서버 응답 대기 포함.

빌드 완료 후 파일 확인:
```bash
ls release/Claude-Inspector-{VERSION}-*.dmg
```

기대 결과: `Claude-Inspector-X.X.X-arm64.dmg`, `Claude-Inspector-X.X.X-x64.dmg` 2개

---

## Step 3: SHA256 계산

```bash
shasum -a 256 "release/Claude-Inspector-{VERSION}-arm64.dmg"
shasum -a 256 "release/Claude-Inspector-{VERSION}-x64.dmg"
```

두 값을 메모해둔다.

---

## Step 4: GitHub Release 생성 + DMG 업로드

```bash
gh release create v{VERSION} \
  "release/Claude-Inspector-{VERSION}-arm64.dmg" \
  "release/Claude-Inspector-{VERSION}-x64.dmg" \
  --title "v{VERSION}" \
  --notes "## 변경사항\n- 업데이트 내용"
```

`--notes`는 실제 변경사항으로 채운다. git log로 이전 태그 이후 커밋 확인:
```bash
git log $(git describe --tags --abbrev=0 2>/dev/null || echo "")..HEAD --oneline 2>/dev/null || git log --oneline -10
```

---

## Step 5: Homebrew cask 업데이트

프로젝트 내 cask 파일과 실제 tap 디렉토리 **둘 다** 수정한다.

### 5-1. 프로젝트 내 cask 수정
`homebrew-tap/Casks/claude-inspector.rb` 에서:
- `version "X.X.X"` → 새 버전
- `on_arm` 블록의 `sha256` → arm64 SHA256
- `on_intel` 블록의 `sha256` → x64 SHA256

### 5-2. 실제 tap 디렉토리에 복사
```bash
HOMEBREW_TAP="$(brew --repository)/Library/Taps/kangraemin/homebrew-tap"
cp homebrew-tap/Casks/claude-inspector.rb "$HOMEBREW_TAP/Casks/claude-inspector.rb"
```

### 5-3. tap 디렉토리에서 커밋+푸시
```bash
cd "$(brew --repository)/Library/Taps/kangraemin/homebrew-tap"
git add Casks/claude-inspector.rb
git commit -m "chore: claude-inspector X.X.X"
git push
cd -
```

---

## Step 6: 완료 확인

```bash
brew update && brew info --cask claude-inspector
```

버전이 새 버전으로 표시되면 성공.

---

## 주의사항
- `release/` 디렉토리에 이전 버전 DMG가 섞여있을 수 있으니 버전명으로 정확히 필터링
- 공증은 Apple 서버 상태에 따라 실패할 수 있음 → 재시도: `source .env && npm run dist:mac`
- `gh release create`는 태그가 없으면 자동 생성, 이미 있으면 에러 → `gh release delete v{VERSION}` 후 재시도
