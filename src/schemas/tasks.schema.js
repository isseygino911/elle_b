const { z } = require('zod');

const nullableAssignedToSchema = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/, 'must be a numeric id')])
  .transform(Number)
  .nullable()
  .optional();

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(255),
  assigned_to: nullableAssignedToSchema,
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be a YYYY-MM-DD date')
    .nullable()
    .optional()
});

const taskIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid task id')
});

const updateTaskStatusSchema = z.object({
  status: z.enum(['pending', 'done'])
});

const listTasksQuerySchema = z.object({
  status: z.enum(['pending', 'done']).optional()
});

module.exports = {
  createTaskSchema,
  taskIdParamSchema,
  updateTaskStatusSchema,
  listTasksQuerySchema
};
