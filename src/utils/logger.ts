import winston from 'winston';
import WinstonCloudWatch from 'winston-cloudwatch';
import { CONFIG } from '../config/config';
import { AWS_CONFIG } from '../config/aws';

// Common format for all environments
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
);

// Base transports that will be used in all environments
const baseTransports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      logFormat
    )
  }),
  new winston.transports.File({ 
    filename: 'logs/application.log',
    format: logFormat
  })
];

// Production-only transports
const productionTransports: winston.transport[] = [
  new WinstonCloudWatch({
    logGroupName: 'GpteeRelay/ApplicationLogs',
    logStreamName: `${CONFIG.env}-${new Date().toISOString().split('T')[0]}`,
    awsRegion: AWS_CONFIG.region,
    jsonMessage: true,
    messageFormatter: (info: any) => 
      JSON.stringify({ 
        level: info.level, 
        message: info.message, 
        additionalInfo: info.additionalInfo,
        environment: CONFIG.env,
        timestamp: new Date().toISOString() 
      }),
    uploadRate: 2000,
    errorHandler: (err: Error) => console.error('CloudWatch error:', err)
  })
];

// Create the logger with environment-specific configuration
export const logger = winston.createLogger({
  level: CONFIG.isProduction ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: CONFIG.isProduction 
    ? [...baseTransports, ...productionTransports]
    : baseTransports
});

// Add a startup message to verify the environment
logger.info(`Logger initialized in ${CONFIG.env} environment`);

export default logger;
