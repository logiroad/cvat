# Copyright (C) Logiroad
#
# SPDX-License-Identifier: MIT

"""
Logiroad-specific view helpers.

Kept in a separate module so that the changes needed in the upstream CVAT
views stay limited to the call sites, which keeps rebases on upstream cheap.
"""

from rest_framework.exceptions import ValidationError

from cvat.apps.engine.models import Job, JobQuerySet, Project, StateChoice, Task

# How many job ids are listed in the error message when a resource cannot be removed
_MAX_REPORTED_STARTED_JOBS = 10


def _check_jobs_are_new(jobs: JobQuerySet, resource_description: str) -> None:
    """
    Raises a ValidationError if any of the jobs is not in the "new" state.
    """

    started_job_ids = list(
        jobs.exclude(state=StateChoice.NEW.value)
        .order_by("id")
        .values_list("id", flat=True)[: _MAX_REPORTED_STARTED_JOBS + 1]
    )

    if not started_job_ids:
        return

    reported_ids = ", ".join(map(str, started_job_ids[:_MAX_REPORTED_STARTED_JOBS]))
    if len(started_job_ids) > _MAX_REPORTED_STARTED_JOBS:
        reported_ids += ", ..."

    raise ValidationError(
        'The {} cannot be removed because it has jobs not in the "{}" state: {}'.format(
            resource_description, StateChoice.NEW.value, reported_ids
        )
    )


def check_job_is_new(job: Job) -> None:
    """
    Raises a ValidationError if the job cannot be removed because it has been started.
    """

    if job.state != StateChoice.NEW.value:
        raise ValidationError(
            'The job cannot be removed because its state is not "{}"'.format(StateChoice.NEW.value)
        )


def check_task_jobs_are_new(task: Task) -> None:
    """
    Raises a ValidationError if the task cannot be removed because one of its jobs
    has been started.
    """

    _check_jobs_are_new(Job.objects.filter(segment__task=task), "task")


def check_project_jobs_are_new(project: Project) -> None:
    """
    Raises a ValidationError if the project cannot be removed because one of the jobs
    of one of its tasks has been started.
    """

    _check_jobs_are_new(Job.objects.filter(segment__task__project=project), "project")
