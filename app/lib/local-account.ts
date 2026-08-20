"use client";

export type LocalAccountProfile = {
  id: string;
  username: string;
  createdAt: number;
};

type LocalAccountRecord = LocalAccountProfile & {
  normalizedUsername: string;
  passwordSalt: string;
  passwordHash: string;
};

const ACCOUNTS_KEY = "video-script-test-accounts-v1";
const SESSION_KEY = "video-script-test-session-v1";
const SETTINGS_PREFIX = "douyin-script-web-settings-v2:local:";

function normalizeUsername(value: string) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function readAccounts(): LocalAccountRecord[] {
  try {
    const stored = window.localStorage.getItem(ACCOUNTS_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed as LocalAccountRecord[] : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts: LocalAccountRecord[]) {
  window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

function randomHex(length = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string, salt: string) {
  const input = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function toProfile(account: LocalAccountRecord): LocalAccountProfile {
  return { id: account.id, username: account.username, createdAt: account.createdAt };
}

function validateCredentials(username: string, password: string) {
  const cleanUsername = username.trim();
  if (cleanUsername.length < 2) throw new Error("账号至少需要 2 个字符");
  if (cleanUsername.length > 40) throw new Error("账号不能超过 40 个字符");
  if (password.length < 4) throw new Error("测试密码至少需要 4 个字符");
  if (password.length > 100) throw new Error("密码不能超过 100 个字符");
  return cleanUsername;
}

export function localSettingsKey(accountId: string) {
  return `${SETTINGS_PREFIX}${accountId}`;
}

export function getCurrentLocalAccount(): LocalAccountProfile | null {
  try {
    const accountId = window.localStorage.getItem(SESSION_KEY);
    if (!accountId) return null;
    const account = readAccounts().find((item) => item.id === accountId);
    if (!account) {
      window.localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return toProfile(account);
  } catch {
    return null;
  }
}

export async function registerLocalAccount(username: string, password: string) {
  const cleanUsername = validateCredentials(username, password);
  const normalizedUsername = normalizeUsername(cleanUsername);
  const accounts = readAccounts();
  if (accounts.some((item) => item.normalizedUsername === normalizedUsername)) {
    throw new Error("这个账号已经存在，请直接登录");
  }

  const passwordSalt = randomHex();
  const account: LocalAccountRecord = {
    id: crypto.randomUUID(),
    username: cleanUsername,
    normalizedUsername,
    passwordSalt,
    passwordHash: await hashPassword(password, passwordSalt),
    createdAt: Date.now(),
  };
  writeAccounts([...accounts, account]);
  window.localStorage.setItem(SESSION_KEY, account.id);
  return toProfile(account);
}

export async function loginLocalAccount(username: string, password: string) {
  const cleanUsername = validateCredentials(username, password);
  const account = readAccounts().find((item) => item.normalizedUsername === normalizeUsername(cleanUsername));
  if (!account || await hashPassword(password, account.passwordSalt) !== account.passwordHash) {
    throw new Error("账号或密码不正确");
  }
  window.localStorage.setItem(SESSION_KEY, account.id);
  return toProfile(account);
}

export function logoutLocalAccount() {
  window.localStorage.removeItem(SESSION_KEY);
}
