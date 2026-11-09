import express from 'express';
import multer from 'multer';
import storageService from '../services/storage/storageService.js';
import { IncuBrixError } from '../utils/errors.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const router = express.Router();

// GET /api/v1/storage/files/:category/:filename - Download stored file or pack
router.get('/files/:category/:filename', (req, res, next) => {
  const { category, filename } = req.params;
  const filePath = storageService.getFilePath(category, filename);

  if (!filePath) {
    return next(new IncuBrixError('FILE_NOT_FOUND', `File '${filename}' in category '${category}' not found`, {}, 404));
  }

  res.sendFile(filePath);
});

// POST /api/v1/storage/upload - Upload input file or media attachment
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new IncuBrixError('VALIDATION_ERROR', 'No file was provided in upload payload', {}, 400);
    }

    const filename = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9_\-\.]/g, '_')}`;
    const result = await storageService.saveFile('uploads', filename, req.file.buffer);

    res.status(201).json({
      message: 'File uploaded successfully',
      ...result
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/storage/assisted/:filename - Download assisted connector pack files
router.get('/assisted/:filename', (req, res, next) => {
  const { filename } = req.params;
  const filePath = storageService.getFilePath('assisted', filename);

  if (!filePath) {
    return next(new IncuBrixError('FILE_NOT_FOUND', `Assisted pack file '${filename}' not found`, {}, 404));
  }

  res.sendFile(filePath);
});

export default router;

