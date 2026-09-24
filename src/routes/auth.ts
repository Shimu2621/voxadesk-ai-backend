import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Response } from "express";
import argon2 from "argon2";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { emailProvider } from "../integrations/email.js";
import { env } from "../config/env.js";
import {
  hashToken,
  csrfCookieName,
  requireAuth,
  requireCsrf,
  sessionCookieName,
} from "../middleware/auth.js";

const credentials = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10).max(128),
});
const signup = credentials.extend({
  name: z.string().trim().min(2).max(80),
  organizationName: z.string().trim().min(2).max(100),
});
const maxAge = 7 * 24 * 60 * 60 * 1000;
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge,
};
const slugify = (value: string) =>
  `${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")}-${randomBytes(3).toString("hex")}`;

type OAuthProvider = "google" | "github";
type OAuthProfile = { email: string; name?: string };
const oauthCookieName = "voxadesk_oauth";
const oauthCookieOptions = {
  ...cookieOptions,
  maxAge: 10 * 60 * 1000,
  path: "/api/v1/auth/oauth",
};
const oauthConfig = {
  google: {
    clientId: () => env.GOOGLE_CLIENT_ID,
    clientSecret: () => env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  },
  github: {
    clientId: () => env.GITHUB_CLIENT_ID,
    clientSecret: () => env.GITHUB_CLIENT_SECRET,
    authorizeUrl: "https://github.com/login/oauth/authorize",
  },
} as const;

const oauthCallbackUrl = (provider: OAuthProvider) =>
  `${env.PUBLIC_WEBHOOK_BASE_URL}/api/v1/auth/oauth/${provider}/callback`;
const oauthErrorRedirect = (res: Response, message: string) =>
  res.redirect(
    `${env.FRONTEND_URL}/login?oauth_error=${encodeURIComponent(message)}`,
  );
const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
};
const codeChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

async function exchangeOAuthCode(
  provider: OAuthProvider,
  code: string,
  verifier: string,
) {
  const config = oauthConfig[provider];
  const clientId = config.clientId();
  const clientSecret = config.clientSecret();
  if (!clientId || !clientSecret) throw new Error("OAUTH_NOT_CONFIGURED");
  const endpoint =
    provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://github.com/login/oauth/access_token";
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: oauthCallbackUrl(provider),
    code_verifier: verifier,
    ...(provider === "google" ? { grant_type: "authorization_code" } : {}),
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!response.ok || !payload.access_token) throw new Error("OAUTH_EXCHANGE");
  return payload.access_token;
}

async function getOAuthProfile(
  provider: OAuthProvider,
  accessToken: string,
): Promise<OAuthProfile> {
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "VoxaDesk-AI",
  };
  if (provider === "google") {
    const response = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      {
        headers,
        signal: AbortSignal.timeout(10_000),
      },
    );
    const profile = (await response.json()) as {
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    if (!response.ok || !profile.email || !profile.email_verified)
      throw new Error("OAUTH_EMAIL");
    return { email: profile.email.toLowerCase(), name: profile.name };
  }
  const [userResponse, emailResponse] = await Promise.all([
    fetch("https://api.github.com/user", {
      headers,
      signal: AbortSignal.timeout(10_000),
    }),
    fetch("https://api.github.com/user/emails", {
      headers,
      signal: AbortSignal.timeout(10_000),
    }),
  ]);
  const user = (await userResponse.json()) as { name?: string; login?: string };
  const emails = (await emailResponse.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;
  const selected =
    emails.find((email) => email.primary && email.verified) ??
    emails.find((email) => email.verified);
  if (!userResponse.ok || !emailResponse.ok || !selected)
    throw new Error("OAUTH_EMAIL");
  return {
    email: selected.email.toLowerCase(),
    name: user.name ?? user.login,
  };
}

async function issueSession(userId: string, organizationId: string) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  await prisma.session.create({
    data: {
      userId,
      organizationId,
      tokenHash: hashToken(token),
      csrfHash: hashToken(csrfToken),
      expiresAt: new Date(Date.now() + maxAge),
    },
  });
  return { token, csrfToken };
}

function setSessionCookies(
  res: Response,
  session: { token: string; csrfToken: string },
) {
  res.cookie(sessionCookieName, session.token, cookieOptions);
  res.cookie(csrfCookieName, session.csrfToken, {
    ...cookieOptions,
    httpOnly: false,
  });
}

async function issueAuthToken(
  userId: string,
  purpose: "verify-email" | "reset-password",
) {
  const token = randomBytes(32).toString("base64url");
  await prisma.authToken.create({
    data: {
      userId,
      purpose,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
}

export const authRouter = Router();

authRouter.get("/oauth/:provider", (req, res) => {
  const parsedProvider = z
    .enum(["google", "github"])
    .safeParse(req.params.provider);
  if (!parsedProvider.success) {
    oauthErrorRedirect(res, "Unsupported sign-in provider.");
    return;
  }
  const provider = parsedProvider.data;
  const config = oauthConfig[provider];
  const clientId = config.clientId();
  if (!clientId || !config.clientSecret()) {
    oauthErrorRedirect(
      res,
      `${provider === "google" ? "Google" : "GitHub"} sign-in is not configured yet.`,
    );
    return;
  }
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  res.cookie(
    oauthCookieName,
    `${provider}.${state}.${verifier}`,
    oauthCookieOptions,
  );
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: oauthCallbackUrl(provider),
    response_type: "code",
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: "S256",
    scope:
      provider === "google" ? "openid email profile" : "read:user user:email",
  });
  res.redirect(`${config.authorizeUrl}?${query.toString()}`);
});

authRouter.get("/oauth/:provider/callback", async (req, res) => {
  const parsedProvider = z
    .enum(["google", "github"])
    .safeParse(req.params.provider);
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state =
    typeof req.query.state === "string" ? req.query.state : undefined;
  const stored = req.cookies?.[oauthCookieName] as string | undefined;
  res.clearCookie(oauthCookieName, { path: oauthCookieOptions.path });
  if (!parsedProvider.success || !code || !state || !stored) {
    oauthErrorRedirect(res, "The sign-in request is invalid or expired.");
    return;
  }
  const provider = parsedProvider.data;
  const [storedProvider, storedState, verifier] = stored.split(".");
  if (
    storedProvider !== provider ||
    !storedState ||
    !verifier ||
    !safeEqual(state, storedState)
  ) {
    oauthErrorRedirect(res, "The sign-in request could not be verified.");
    return;
  }
  try {
    const accessToken = await exchangeOAuthCode(provider, code, verifier);
    const profile = await getOAuthProfile(provider, accessToken);
    let user = await prisma.user.findUnique({
      where: { email: profile.email },
      include: { memberships: true },
    });
    let organizationId = user?.memberships[0]?.organizationId;
    if (!user || !organizationId) {
      const workspaceName = `${profile.name ?? profile.email.split("@")[0]}'s Workspace`;
      const created = await prisma.$transaction(async (tx) => {
        const oauthUser = user
          ? await tx.user.update({
              where: { id: user.id },
              data: {
                verifiedAt: user.verifiedAt ?? new Date(),
                name: user.name ?? profile.name,
              },
            })
          : await tx.user.create({
              data: {
                email: profile.email,
                name: profile.name,
                verifiedAt: new Date(),
              },
            });
        const organization = await tx.organization.create({
          data: {
            name: workspaceName,
            slug: slugify(workspaceName),
            memberships: { create: { userId: oauthUser.id, role: "OWNER" } },
          },
        });
        return { user: oauthUser, organization };
      });
      user = { ...created.user, memberships: [] };
      organizationId = created.organization.id;
      await audit({
        organizationId,
        actorId: user.id,
        action: "organization.created",
        targetType: "organization",
        targetId: organizationId,
        metadata: { authenticationProvider: provider },
      });
    } else if (!user.verifiedAt) {
      user = {
        ...user,
        ...(await prisma.user.update({
          where: { id: user.id },
          data: { verifiedAt: new Date(), name: user.name ?? profile.name },
        })),
      };
    }
    setSessionCookies(res, await issueSession(user.id, organizationId));
    res.redirect(`${env.FRONTEND_URL}/app`);
  } catch {
    oauthErrorRedirect(
      res,
      "Social sign-in could not be completed. Please try again.",
    );
  }
});

authRouter.post("/signup", async (req, res) => {
  const input = signup.parse(req.body);
  if (await prisma.user.findUnique({ where: { email: input.email } })) {
    res.status(409).json({
      code: "EMAIL_IN_USE",
      message: "An account already uses this email.",
    });
    return;
  }
  const passwordHash = await argon2.hash(input.password);
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
        verifiedAt: null,
      },
    });
    const organization = await tx.organization.create({
      data: {
        name: input.organizationName,
        slug: slugify(input.organizationName),
        memberships: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    return { user, organization };
  });
  setSessionCookies(
    res,
    await issueSession(result.user.id, result.organization.id),
  );
  const verificationToken = await issueAuthToken(
    result.user.id,
    "verify-email",
  );
  await emailProvider.send({
    to: result.user.email,
    subject: "Verify your VoxaDesk AI email",
    text: `Use this one-time verification token: ${verificationToken}`,
  });
  await audit({
    organizationId: result.organization.id,
    actorId: result.user.id,
    action: "organization.created",
    targetType: "organization",
    targetId: result.organization.id,
  });
  res.status(201).json({
    data: {
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
      },
      organization: result.organization,
    },
  });
});
authRouter.post("/login", async (req, res) => {
  const input = credentials.parse(req.body);
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { memberships: { include: { organization: true } } },
  });
  if (
    !user?.passwordHash ||
    !(await argon2.verify(user.passwordHash, input.password))
  ) {
    res.status(401).json({
      code: "INVALID_CREDENTIALS",
      message: "Email or password is incorrect.",
    });
    return;
  }
  if (!user.verifiedAt) {
    res.status(403).json({
      code: "EMAIL_NOT_VERIFIED",
      message: "Verify your email before signing in.",
    });
    return;
  }
  const membership = user.memberships[0];
  if (!membership) {
    res.status(403).json({
      code: "NO_ORGANIZATION",
      message: "This account does not belong to an organization.",
    });
    return;
  }
  setSessionCookies(
    res,
    await issueSession(user.id, membership.organizationId),
  );
  res.json({
    data: {
      user: { id: user.id, email: user.email, name: user.name },
      organizations: user.memberships.map((m) => ({
        ...m.organization,
        role: m.role,
      })),
    },
  });
});
authRouter.post("/verify-email", async (req, res) => {
  const input = z.object({ token: z.string().min(32) }).parse(req.body);
  const record = await prisma.authToken.findFirst({
    where: {
      tokenHash: hashToken(input.token),
      purpose: "verify-email",
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!record) {
    res.status(400).json({
      code: "INVALID_TOKEN",
      message: "The verification token is invalid or expired.",
    });
    return;
  }
  await prisma.$transaction([
    prisma.authToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: { verifiedAt: new Date() },
    }),
  ]);
  res.status(204).end();
});
authRouter.post("/forgot-password", async (req, res) => {
  const { email } = z
    .object({ email: z.string().trim().toLowerCase().email() })
    .parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    const token = await issueAuthToken(user.id, "reset-password");
    await emailProvider.send({
      to: email,
      subject: "Reset your VoxaDesk AI password",
      text: `Use this one-time password reset token: ${token}`,
    });
  }
  res
    .status(202)
    .json({ message: "If the account exists, reset instructions were sent." });
});
authRouter.post("/reset-password", async (req, res) => {
  const input = z
    .object({
      token: z.string().min(32),
      password: z.string().min(10).max(128),
    })
    .parse(req.body);
  const record = await prisma.authToken.findFirst({
    where: {
      tokenHash: hashToken(input.token),
      purpose: "reset-password",
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!record) {
    res.status(400).json({
      code: "INVALID_TOKEN",
      message: "The reset token is invalid or expired.",
    });
    return;
  }
  await prisma.$transaction([
    prisma.authToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await argon2.hash(input.password) },
    }),
    prisma.session.deleteMany({ where: { userId: record.userId } }),
  ]);
  res.status(204).end();
});
authRouter.post("/accept-invitation", async (req, res) => {
  const input = z
    .object({
      token: z.string().min(32),
      name: z.string().trim().min(2).max(80).optional(),
      password: z.string().min(10).max(128).optional(),
    })
    .parse(req.body);
  const invitation = await prisma.invitation.findFirst({
    where: {
      tokenHash: hashToken(input.token),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!invitation) {
    res.status(400).json({
      code: "INVALID_INVITATION",
      message: "The invitation is invalid or expired.",
    });
    return;
  }
  const existing = await prisma.user.findUnique({
    where: { email: invitation.email },
  });
  if (!existing && (!input.name || !input.password)) {
    res.status(400).json({
      code: "ACCOUNT_DETAILS_REQUIRED",
      message: "Name and password are required for a new account.",
    });
    return;
  }
  const result = await prisma.$transaction(async (tx) => {
    const consumed = await tx.invitation.updateMany({
      where: {
        id: invitation.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { acceptedAt: new Date() },
    });
    if (consumed.count !== 1)
      throw new Error("Invitation was already consumed.");
    const user =
      existing ??
      (await tx.user.create({
        data: {
          email: invitation.email,
          name: input.name!,
          passwordHash: await argon2.hash(input.password!),
          verifiedAt: new Date(),
        },
      }));
    await tx.membership.upsert({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId,
          userId: user.id,
        },
      },
      create: {
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
      },
      update: {},
    });
    return { user, created: !existing };
  });
  await audit({
    organizationId: invitation.organizationId,
    actorId: result.user.id,
    action: "invitation.accepted",
    targetType: "invitation",
    targetId: invitation.id,
    metadata: { role: invitation.role },
  });
  if (result.created)
    setSessionCookies(
      res,
      await issueSession(result.user.id, invitation.organizationId),
    );
  res.status(200).json({
    data: {
      organizationId: invitation.organizationId,
      requiresLogin: !result.created,
    },
  });
});
authRouter.post(
  "/switch-organization",
  requireAuth,
  requireCsrf,
  async (req, res) => {
    const { organizationId } = z
      .object({ organizationId: z.string().cuid() })
      .parse(req.body);
    const membership = await prisma.membership.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: req.auth!.userId },
      },
    });
    if (!membership) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Organization not found." });
      return;
    }
    const oldToken = req.cookies?.[sessionCookieName] as string;
    await prisma.session.deleteMany({
      where: { tokenHash: hashToken(oldToken) },
    });
    setSessionCookies(
      res,
      await issueSession(req.auth!.userId, organizationId),
    );
    res.status(204).end();
  },
);
authRouter.post("/logout", requireCsrf, async (req, res) => {
  const token = req.cookies?.[sessionCookieName] as string | undefined;
  if (token)
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  res.clearCookie(sessionCookieName, { path: "/" });
  res.clearCookie(csrfCookieName, { path: "/" });
  res.status(204).end();
});
authRouter.get("/me", requireAuth, async (req, res) => {
  const membership = await prisma.membership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: req.auth!.organizationId,
        userId: req.auth!.userId,
      },
    },
    include: { user: true, organization: true },
  });
  res.json({
    data: {
      user: {
        id: membership!.user.id,
        email: membership!.user.email,
        name: membership!.user.name,
      },
      organization: membership!.organization,
      role: membership!.role,
    },
  });
});
