import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = ((err as any).issues || (err as any).errors || []).map((e: any) => ({
          field: Array.isArray(e.path) ? e.path.join(".") : "",
          message: e.message,
        }));
        res.status(400).json({
          error: "Validation failed",
          issues,
        });
        return;
      }
      next(err);
    }
  };
}