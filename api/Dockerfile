# platform-tenants Lambda (arm64, matches the function's architectures).
FROM public.ecr.aws/lambda/python:3.13-arm64

# boto3 ships with the runtime, Stripe is called over plain HTTPS (urllib).
# Pillow (requirements.txt) makes the backdrop thumbnails (app/backdrop.py).
COPY requirements.txt .
RUN pip install -r requirements.txt --target "${LAMBDA_TASK_ROOT}" --no-cache-dir

COPY src/app ${LAMBDA_TASK_ROOT}/app

CMD ["app.handler.handler"]
