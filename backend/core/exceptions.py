# backend/core/exceptions.py
from typing import Optional, Dict, Any

class AppException(Exception):
    """Base exception"""
    def __init__(
        self,
        message: str,
        status_code: int = 500,
        error_type: str = "internal_error",
        details: Optional[Dict[str, Any]] = None
    ):
        self.message = message
        self.status_code = status_code
        self.error_type = error_type
        self.details = details or {}
        super().__init__(self.message)

class ValidationError(AppException):
    """Input validation failed"""
    def __init__(self, message: str):
        super().__init__(
            message=message,
            status_code=400,
            error_type="validation_error"
        )

class ExternalServiceError(AppException):
    """External API failed (Gemini)"""
    def __init__(self, message: str, service_name: str):
        super().__init__(
            message=message,
            status_code=502,
            error_type="external_service_error",
            details={"service": service_name}
        )