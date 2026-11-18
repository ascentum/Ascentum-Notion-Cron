import { Person, SnippetType } from "./types";

const PERSON_NAMES_KO: Record<Person, string> = {
  youngmin: "박영민",
};

const PERSON_COLORS: Record<Person, number> = {
  youngmin: 0x5865f2,
};

export const DEFAULT_HEALTH_SCORE = 5;

export function normalizeHealthScore(score: number | string | null | undefined): number {
  const parsed =
    typeof score === "number" ? score : Number.parseInt(score ?? "", 10);

  if (Number.isNaN(parsed) || parsed < 1 || parsed > 10) {
    return DEFAULT_HEALTH_SCORE;
  }

  return parsed;
}

export function appendHealthCheck(
  content: string,
  score: number | string = DEFAULT_HEALTH_SCORE
) {
  const normalized = normalizeHealthScore(score);
  return `${content.trimEnd()}\n\n헬스 체크 (10점)\n${normalized}`;
}

export function normalizeDailyTaskListIndentation(content: string): string {
  const headings = [...content.matchAll(
    /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(오늘 한 일|수행 목적|오늘의 배움 또는 남길 말|헬스 체크 \(10점\))(?:\*\*)?[ \t]*\r?$/gm
  )];
  const taskHeadingIndex = headings.findIndex((heading) => heading[1] === "오늘 한 일");
  if (taskHeadingIndex === -1) return content;

  const taskHeading = headings[taskHeadingIndex];
  const start = taskHeading.index + taskHeading[0].length;
  const end = headings[taskHeadingIndex + 1]?.index ?? content.length;
  // Discord requires two spaces before a nested bullet.
  const taskList = content.slice(start, end).replace(/^ (?=[*-] )/gm, "  ");
  return content.slice(0, start) + taskList + content.slice(end);
}

export function personNameKo(person: Person) {
  return PERSON_NAMES_KO[person];
}

export function snippetTypeKo(type: SnippetType) {
  return type === "daily" ? "데일리" : "주간";
}

export function snippetColor(person: Person) {
  return PERSON_COLORS[person];
}

export function buildSnippetTitle(
  person: Person,
  type: SnippetType,
  dateLabel: string
) {
  return `📋 ${personNameKo(person)} | ${snippetTypeKo(type)} 스니펫 (${dateLabel})`;
}

export function buildPendingSnippetEmbed(
  person: Person,
  type: SnippetType,
  dateLabel: string,
  content: string
) {
  return {
    title: buildSnippetTitle(person, type, dateLabel),
    description: content,
    color: snippetColor(person),
    footer: { text: "30분 내 응답 없으면 자동 게시됩니다" },
  };
}

export function buildPendingSnippetComponents(person: Person, type: SnippetType) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "그대로 게시 ✅",
          custom_id: `post:${person}:${type}`,
        },
        {
          type: 2,
          style: 1,
          label: "헬스체크 입력 🔢",
          custom_id: `health:${person}:${type}`,
        },
        {
          type: 2,
          style: 2,
          label: "수정하기 ✏️",
          custom_id: `edit:${person}:${type}`,
        },
        {
          type: 2,
          style: 4,
          label: "건너뛰기 ⏭️",
          custom_id: `skip:${person}:${type}`,
        },
      ],
    },
  ];
}

export function buildCompletedSnippetEmbed(
  person: Person,
  type: SnippetType,
  dateLabel: string,
  content: string,
  footerText: string,
  color: number
) {
  return {
    title: buildSnippetTitle(person, type, dateLabel),
    description: content,
    color,
    footer: { text: footerText },
  };
}

export function buildNoTaskWarningEmbed(person: Person, dateLabel: string) {
  return {
    title: `⚠️ ${personNameKo(person)} | 오늘 기록된 업무 없음 (${dateLabel})`,
    description:
      "어센텀 업무 DB에 오늘 완료 처리된 업무가 없어요!\n" +
      "혹시 까먹으셨나요? 업무의 '완료' 체크 후 `/snippet` 명령어로 다시 실행할 수 있어요.",
    color: snippetColor(person),
    footer: { text: "업무를 완료 체크한 뒤 /snippet 으로 강제 실행하세요" },
  };
}
