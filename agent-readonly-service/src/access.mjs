import { createRemoteJWKSet, jwtVerify } from 'jose';

export async function accessSubject(request, env, keys) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_ISSUER || !env.ACCESS_AUD) return null;
  try {
    const { payload } = await jwtVerify(token, keys ?? createRemoteJWKSet(new URL('/cdn-cgi/access/certs', env.ACCESS_ISSUER)), {
      issuer: env.ACCESS_ISSUER,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat'],
    });
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
