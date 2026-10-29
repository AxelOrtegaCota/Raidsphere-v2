import { z } from 'zod';

export const serverConfigSchema = z.object({
  host: z.enum(['127.0.0.1', '0.0.0.0']),
  port: z.number().int().min(1).max(65535),
}).strict();

export type ServerConfig = z.infer<typeof serverConfigSchema>;

const decimalPortSchema = z.string().min(1).max(5).refine(
  (value) => !/[^0-9]/.test(value),
  'The port must contain only decimal digits.',
);

export function loadServerConfig(environment: { PORT?: string; HOST?: string }): ServerConfig {
  const port = environment.PORT === undefined ? 3000 : Number(decimalPortSchema.parse(environment.PORT));
  const host = environment.HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  return serverConfigSchema.parse({
    host,
    port,
  });
}
