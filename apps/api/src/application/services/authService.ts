import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { User, UserRole } from "../../domain/auth/models.js";
import type { Session } from "../../domain/auth/session.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../domain/shared/errors.js";
import type { SessionRepository, UserRepository } from "../ports/repositories.js";
const scrypt = promisify(nodeScrypt);
export interface AuthConfig {
  jwtSecret: string;
  refreshSecret: string;
  accessExpiresIn: string;
  refreshExpiresIn: string;
}
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    jobTitle: string;
    role: UserRole;
    active: boolean;
  };
}

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly config: AuthConfig,
    private readonly sessions?: SessionRepository,
  ) {}
  async ensureAdmin(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    const existing = await this.findUserByUsername(normalizedUsername);
    if (existing) return existing;
    const now = new Date().toISOString();
    const credentials = await hashPassword(password);
    const user: User = {
      id: crypto.randomUUID(),
      username: normalizedUsername,
      displayName: normalizedUsername,
      jobTitle: "Administrador",
      passwordHash: credentials.hash,
      passwordSalt: credentials.salt,
      role: "ADMIN",
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.users.saveUser(user);
    return user;
  }
  async listUsers() {
    return (await this.users.listUsers())
      .sort((left, right) => left.username.localeCompare(right.username, "es"))
      .map((user) => this.publicUser(user));
  }
  async createUser(
    username: string,
    password: string,
    role: UserRole,
    displayName = username,
    jobTitle = roleLabel(role),
  ) {
    const normalizedUsername = normalizeUsername(username);
    if (await this.findUserByUsername(normalizedUsername))
      throw new ConflictError("El nombre de usuario ya existe");
    const now = new Date().toISOString();
    const credentials = await hashPassword(password);
    const user: User = {
      id: crypto.randomUUID(),
      username: normalizedUsername,
      displayName: displayName.trim(),
      jobTitle: jobTitle.trim(),
      passwordHash: credentials.hash,
      passwordSalt: credentials.salt,
      role,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.users.saveUser(user);
    return this.publicUser(user);
  }
  async updateUser(
    id: string,
    input: {
      username?: string | undefined;
      displayName?: string | undefined;
      jobTitle?: string | undefined;
      password?: string | undefined;
      role?: UserRole | undefined;
      active?: boolean | undefined;
    },
    actorUsername?: string,
  ) {
    const users = await this.users.listUsers();
    const user = users.find((item) => item.id === id);
    if (!user) throw new NotFoundError("Usuario no encontrado");
    const normalizedUsername = input.username ? normalizeUsername(input.username) : user.username;
    if (normalizedUsername.length < 3)
      throw new BusinessRuleError("El nombre de usuario debe tener al menos 3 caracteres");
    if (
      users.some(
        (item) => item.id !== id && normalizeUsername(item.username) === normalizedUsername,
      )
    )
      throw new ConflictError("El nombre de usuario ya existe");
    const resultingActive = input.active ?? user.active;
    const resultingRole = input.role ?? user.role;
    const removingAdminAccess =
      user.role === "ADMIN" && user.active && (!resultingActive || resultingRole !== "ADMIN");
    const remainingActiveAdmins = users.filter(
      (item) => item.id !== id && item.active && item.role === "ADMIN",
    );
    if (removingAdminAccess && remainingActiveAdmins.length === 0)
      throw new BusinessRuleError("Debe existir al menos un administrador activo en el sistema");
    const isCurrentUser =
      actorUsername !== undefined &&
      normalizeUsername(actorUsername) === normalizeUsername(user.username);
    if (isCurrentUser && (input.active === false || resultingRole !== "ADMIN"))
      throw new BusinessRuleError("No puedes inactivar ni retirar tu propio acceso administrativo");
    const credentials =
      input.password !== undefined
        ? await hashPassword(input.password)
        : { hash: user.passwordHash, salt: user.passwordSalt };
    const updated = {
      ...user,
      username: normalizedUsername,
      ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
      ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle.trim() } : {}),
      role: resultingRole,
      active: resultingActive,
      passwordHash: credentials.hash,
      passwordSalt: credentials.salt,
      updatedAt: new Date().toISOString(),
    };
    await this.users.saveUser(updated);
    return this.publicUser(updated);
  }
  async currentUser(username: string) {
    const user = await this.findUserByUsername(username);
    return user && user.active ? this.publicUser(user) : null;
  }
  async changePassword(username: string, currentPassword: string, newPassword: string) {
    const user = await this.findUserByUsername(username);
    if (
      !user ||
      !user.active ||
      !(await verifyPassword(currentPassword, user.passwordHash, user.passwordSalt))
    )
      return false;
    const credentials = await hashPassword(newPassword);
    await this.users.saveUser({
      ...user,
      passwordHash: credentials.hash,
      passwordSalt: credentials.salt,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }
  async login(username: string, password: string): Promise<AuthTokens | null> {
    const user = await this.findUserByUsername(username);
    if (!user || !user.active) return null;
    const valid = await verifyPassword(password, user.passwordHash, user.passwordSalt);
    if (!valid) return null;
    return this.tokens(user);
  }
  async refresh(token: string): Promise<AuthTokens | null> {
    try {
      const payload = jwt.verify(token, this.config.refreshSecret) as {
        sub: string;
        username: string;
        role: UserRole;
        type: string;
        jti?: string;
      };
      if (payload.type !== "refresh") return null;
      if (this.sessions && payload.jti) {
        const session = await this.sessions.findSessionById(payload.jti);
        if (
          !session ||
          session.revokedAt ||
          session.tokenHash !== hashToken(token) ||
          new Date(session.expiresAt) <= new Date()
        )
          return null;
        await this.sessions.revokeSession(session.id, new Date().toISOString());
      }
      const user = await this.findUserByUsername(payload.username);
      if (!user || !user.active) return null;
      return this.tokens(user);
    } catch {
      return null;
    }
  }
  async revokeRefreshToken(token: string) {
    try {
      const payload = jwt.verify(token, this.config.refreshSecret) as { jti?: string };
      if (payload.jti && this.sessions)
        await this.sessions.revokeSession(payload.jti, new Date().toISOString());
    } catch {
      return undefined;
    }
  }
  verifyAccess(token: string): { sub: string; username: string; role: UserRole } | null {
    try {
      const payload = jwt.verify(token, this.config.jwtSecret) as {
        sub: string;
        username: string;
        role: UserRole;
        type: string;
      };
      return payload.type === "access" ? payload : null;
    } catch {
      return null;
    }
  }
  private async findUserByUsername(username: string) {
    const normalizedUsername = normalizeUsername(username);
    const direct = await this.users.findUserByUsername(normalizedUsername);
    if (direct) return direct;
    return (
      (await this.users.listUsers()).find(
        (user) => normalizeUsername(user.username) === normalizedUsername,
      ) ?? null
    );
  }
  private async tokens(user: User): Promise<AuthTokens> {
    const accessToken = jwt.sign(
      { sub: user.id, username: user.username, role: user.role, type: "access" },
      this.config.jwtSecret,
      { expiresIn: this.config.accessExpiresIn } as SignOptions,
    );
    const jti = randomBytes(16).toString("hex");
    const refreshToken = jwt.sign(
      { sub: user.id, username: user.username, role: user.role, type: "refresh", jti },
      this.config.refreshSecret,
      { expiresIn: this.config.refreshExpiresIn } as SignOptions,
    );
    if (this.sessions) {
      const payload = jwt.decode(refreshToken) as { exp?: number };
      const session: Session = {
        id: jti,
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date((payload.exp ?? 0) * 1000).toISOString(),
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };
      await this.sessions.saveSession(session);
    }
    return { accessToken, refreshToken, user: this.publicUser(user) };
  }
  private publicUser(user: User) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName?.trim() || user.username,
      jobTitle: user.jobTitle?.trim() || roleLabel(user.role),
      role: user.role,
      active: user.active,
    };
  }
}
function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}
function roleLabel(role: UserRole) {
  return role === "ADMIN"
    ? "Administrador"
    : role === "HR"
      ? "Talento humano"
      : role === "VIEWER"
        ? "Consulta"
        : "Solo lectura";
}
async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return { hash: derived.toString("hex"), salt };
}
async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function refreshSecretFrom(jwtSecret: string): string {
  return createHash("sha256").update(`${jwtSecret}:refresh`).digest("hex");
}
