import {
  AIWritingAssistantEmail,
  AutoLabelingEmail,
  CategoriesEmail,
  Mail0ProEmail,
  ShortcutsEmail,
  SuperSearchEmail,
  WelcomeEmail,
} from './react-emails/email-sequences';
import { createAuthMiddleware, jwt, bearer, mcp } from 'better-auth/plugins';
import { type Account, betterAuth, type BetterAuthOptions } from 'better-auth';
import { getBrowserTimezone, isValidTimezone } from './timezones';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getZeroDB, resetConnection } from './server-utils';
import { getSocialProviders } from './auth-providers';
import { redis, resend } from './services';
import { defaultUserSettings } from './schemas';
import { disableBrainFunction } from './brain';
import { APIError } from 'better-auth/api';
import { type EProviders } from '../types';
import { createDriver } from './driver';
import { createDb } from '../db';
import { Effect } from 'effect';
import { env } from '../env';

const scheduleCampaign = (userInfo: { address: string; name: string }) =>
  Effect.gen(function* () {
    const name = userInfo.name || 'there';
    const resendService = resend();

    const sendEmail = (subject: string, react: unknown, scheduledAt?: string) =>
      Effect.promise(() =>
        resendService.emails
          .send({
            from: 'HMD Mail <no-reply@mail.hmdpublishing.com>',
            to: userInfo.address,
            subject,
            react: react as any,
            ...(scheduledAt && { scheduledAt }),
          })
          .then(() => void 0),
      );

    const emails = [
      {
        subject: 'Welcome to 0.email',
        react: WelcomeEmail({ name }),
        scheduledAt: undefined,
      },
      {
        subject: 'Mail0 Pro is here 🚀💼',
        react: Mail0ProEmail({ name }),
        scheduledAt: 'in 1 day',
      },
      {
        subject: 'Auto-labeling is here 🎉📥',
        react: AutoLabelingEmail({ name }),
        scheduledAt: 'in 2 days',
      },
      {
        subject: 'AI Writing Assistant is here 🤖💬',
        react: AIWritingAssistantEmail({ name }),
        scheduledAt: 'in 3 days',
      },
      {
        subject: 'Shortcuts are here 🔧🚀',
        react: ShortcutsEmail({ name }),
        scheduledAt: 'in 4 days',
      },
      {
        subject: 'Categories are here 📂🔍',
        react: CategoriesEmail({ name }),
        scheduledAt: 'in 5 days',
      },
      {
        subject: 'Super Search is here 🔍🚀',
        react: SuperSearchEmail({ name }),
        scheduledAt: 'in 6 days',
      },
    ];

    yield* Effect.all(
      emails.map((email) => sendEmail(email.subject, email.react, email.scheduledAt)),
      { concurrency: 'unbounded' },
    );
  });

const connectionHandlerHook = async (account: Account) => {
  console.log('[connectionHandlerHook] Starting for account:', account.providerId, account.userId);
  if (!account.accessToken || !account.refreshToken) {
    console.error('Missing Access/Refresh Tokens', { providerId: account.providerId, userId: account.userId, hasAccess: !!account.accessToken, hasRefresh: !!account.refreshToken });
    throw new APIError('EXPECTATION_FAILED', {
      message: 'Missing Access/Refresh Tokens, contact us on Discord for support',
    });
  }

  const driver = createDriver(account.providerId, {
    auth: {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      userId: account.userId,
      email: '',
    },
  });

  const userInfo = await driver.getUserInfo().catch(async () => {
    if (account.accessToken) {
      await driver.revokeToken(account.accessToken);
      await resetConnection(account.id);
    }
    throw new Response(null, { status: 301, headers: { Location: '/' } });
  });

  if (!userInfo?.address) {
    try {
      await Promise.allSettled(
        [account.accessToken, account.refreshToken]
          .filter(Boolean)
          .map((t) => driver.revokeToken(t as string)),
      );
      await resetConnection(account.id);
    } catch (error) {
      console.error('Failed to revoke tokens:', error);
    }
    throw new Response(null, { status: 303, headers: { Location: '/' } });
  }

  const updatingInfo = {
    name: userInfo.name || 'Unknown',
    picture: userInfo.photo || '',
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    scope: driver.getScope(),
    expiresAt: new Date(Date.now() + (account.accessTokenExpiresAt?.getTime() || 3600000)),
  };

  const db = await getZeroDB(account.userId);
  const [result] = await db.createConnection(
    account.providerId as EProviders,
    userInfo.address,
    updatingInfo,
  );

  try {
    if (env.NODE_ENV === 'production') {
      await Effect.runPromise(
        scheduleCampaign({ address: userInfo.address, name: userInfo.name || 'there' }),
      );
    }
  } catch (error) {
    console.error('[connectionHandlerHook] scheduleCampaign failed (non-fatal):', error);
  }

  if (env.GOOGLE_S_ACCOUNT && env.GOOGLE_S_ACCOUNT !== '{}') {
    await env.subscribe_queue.send({
      connectionId: result.id,
      providerId: account.providerId,
    });
  }
};

export const createAuth = () => {
  return betterAuth({
    plugins: [
      mcp({
        loginPage: env.VITE_PUBLIC_APP_URL + '/login',
      }),
      jwt(),
      bearer(),
    ],
    user: {
      deleteUser: {
        enabled: true,
        async sendDeleteAccountVerification(data) {
          const verificationUrl = data.url;
          await resend().emails.send({
            from: 'HMD Mail <no-reply@mail.hmdpublishing.com>',
            to: data.user.email,
            subject: 'Delete your account',
            html: `<h2>Delete Your Account</h2><p>Click the link below to delete your account:</p><a href="${verificationUrl}">${verificationUrl}</a>`,
          });
        },
        beforeDelete: async (user, request) => {
          if (!request) throw new APIError('BAD_REQUEST', { message: 'Request object is missing' });
          const db = await getZeroDB(user.id);
          const connections = await db.findManyConnections();
          await Promise.allSettled(
            connections.map(async (connection) => {
              if (!connection.accessToken || !connection.refreshToken) return;
              try {
                await disableBrainFunction({
                  id: connection.id,
                  providerId: connection.providerId as EProviders,
                });
                const driver = createDriver(connection.providerId, {
                  auth: {
                    accessToken: connection.accessToken,
                    refreshToken: connection.refreshToken,
                    userId: user.id,
                    email: connection.email,
                  },
                });
                await driver.revokeToken(connection.refreshToken);
              } catch (error) {
                console.error('Failed to revoke connection:', connection.id, error);
              }
            }),
          );
          await db.deleteUser();
        },
      },
    },
    databaseHooks: {
      account: {
        create: {
          after: connectionHandlerHook,
        },
        update: {
          after: connectionHandlerHook,
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/sign-up')) {
          const newSession = ctx.context.newSession;
          if (newSession) {
            const db = await getZeroDB(newSession.user.id);
            const existingSettings = await db.findUserSettings();
            if (!existingSettings) {
              const headerTimezone = ctx.headers?.get('x-vercel-ip-timezone');
              const timezone =
                headerTimezone && isValidTimezone(headerTimezone)
                  ? headerTimezone
                  : getBrowserTimezone();
              await db.insertUserSettings({
                ...defaultUserSettings,
                timezone,
              });
            }
          }
        }
      }),
    },
    ...createAuthConfig(),
  });
};

const createAuthConfig = () => {
  const cache = redis();
  const { db } = createDb(env.HYPERDRIVE.connectionString);
  return {
    database: drizzleAdapter(db, { provider: 'pg' }),
    secondaryStorage: {
      get: async (key: string) => {
        const value = await cache.get(key);
        return typeof value === 'string' ? value : value ? JSON.stringify(value) : null;
      },
      set: async (key: string, value: string, ttl?: number) => {
        if (ttl) await cache.set(key, value, { ex: ttl });
        else await cache.set(key, value);
      },
      delete: async (key: string) => {
        await cache.del(key);
      },
    },
    advanced: {
      ipAddress: {
        disableIpTracking: true,
      },
      cookiePrefix: env.NODE_ENV === 'development' ? 'better-auth-dev' : 'better-auth',
      crossSubDomainCookies: {
        enabled: true,
        domain: env.COOKIE_DOMAIN,
      },
    },
    baseURL: env.VITE_PUBLIC_BACKEND_URL,
    trustedOrigins: [
      'https://app.0.email',
      'https://sapi.0.email',
      'https://staging.0.email',
      'https://0.email',
      'https://mail.hmdpublishing.com',
      'http://localhost:3000',
      ...(env.BETTER_AUTH_TRUSTED_ORIGINS
        ? env.BETTER_AUTH_TRUSTED_ORIGINS.split(',').map((o: string) => o.trim())
        : []),
    ],
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60 * 24 * 30, // 30 days
      },
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24 * 3, // 1 day (every 1 day the session expiration is updated)
    },
    socialProviders: getSocialProviders(env as unknown as Record<string, string>),
    account: {
      accountLinking: {
        enabled: true,
        allowDifferentEmails: true,
        trustedProviders: ['google', 'microsoft'],
      },
    },
    onAPIError: {
      onError: (error) => {
        console.error('API Error', error);
      },
      errorURL: `${env.VITE_PUBLIC_APP_URL}/login`,
      throw: true,
    },
  } satisfies BetterAuthOptions;
};

export const createSimpleAuth = () => {
  return betterAuth(createAuthConfig());
};

export type Auth = ReturnType<typeof createAuth>;
export type SimpleAuth = ReturnType<typeof createSimpleAuth>;
