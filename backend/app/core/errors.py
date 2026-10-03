# backend/app/core/errors.py
"""
Unified error handling.

All application errors use the envelope:
  {"error": {"code": "<CODE>", "message": "<human message>", "details": {...}}}

HTTP status codes follow REST conventions.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = structlog.get_logger(__name__)


# ── Error envelope schemas ────────────────────────────────────────────────────

class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = {}


class ErrorResponse(BaseModel):
    error: ErrorDetail


# ── Application exception hierarchy ──────────────────────────────────────────

class AppError(Exception):
    """Base for all application-defined exceptions."""

    status_code: int = 500
    code: str = "INTERNAL_ERROR"

    def __init__(
        self,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.message = message
        self.details = details or {}
        super().__init__(message)


class NotFoundError(AppError):
    status_code = 404
    code = "NOT_FOUND"


class ValidationError(AppError):
    status_code = 422
    code = "VALIDATION_ERROR"


class UnauthorizedError(AppError):
    status_code = 401
    code = "UNAUTHORIZED"


class ServiceUnavailableError(AppError):
    status_code = 503
    code = "SERVICE_UNAVAILABLE"


class ExternalServiceError(AppError):
    status_code = 502
    code = "EXTERNAL_SERVICE_ERROR"


class AudioTooShortError(ValidationError):
    code = "AUDIO_TOO_SHORT"


class AudioTooLongError(ValidationError):
    code = "AUDIO_TOO_LONG"


# ── Response helpers ──────────────────────────────────────────────────────────

def error_response(
    code: str,
    message: str,
    status: int,
    details: dict[str, Any] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "details": details or {}}},
    )


# ── FastAPI exception handlers ────────────────────────────────────────────────

def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "unknown")


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    logger.warning(
        "application error",
        request_id=_request_id(request),
        code=exc.code,
        message=exc.message,
        status=exc.status_code,
    )
    return error_response(exc.code, exc.message, exc.status_code, exc.details)


async def validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    logger.info(
        "validation error",
        request_id=_request_id(request),
        errors=exc.errors(),
    )
    return error_response(
        "VALIDATION_ERROR",
        "Request validation failed",
        422,
        {"errors": exc.errors()},
    )


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception(
        "unhandled exception",
        request_id=_request_id(request),
        exc_type=type(exc).__name__,
    )
    return error_response("INTERNAL_ERROR", "An unexpected error occurred", 500)


def register_error_handlers(app: FastAPI) -> None:
    """Attach all error handlers to the FastAPI app."""
    app.add_exception_handler(AppError, app_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, validation_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, unhandled_error_handler)  # type: ignore[arg-type]
