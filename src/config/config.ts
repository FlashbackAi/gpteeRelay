/**
 * Global Configuration
 */

export const ENV = process.env.NODE_ENV || 'development';

export const CONFIG = {
  env: ENV,
  isProduction: ENV === 'production',
  isDevelopment: ENV === 'development',
  isTest: ENV === 'test',
};
