import { z } from 'zod';

export const serverConfigSchema = z.object({
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
}).strict();

export type ServerConfig = z.infer<typeof serverConfigSchema>;

const decimalPortSchema = z.string().min(1).max(5).refine(
  (value) => !/[^0-9]/.test(value),
  'The port must contain only decimal digits.',
);

export function loadServerConfig(environment: { PORT?: string }): ServerConfig {
  const port = environment.PORT === undefined ? 3000 : Number(decimalPortSchema.parse(environment.PORT));
  return serverConfigSchema.parse({
    host: '127.0.0.1',
    port,
  });
}
