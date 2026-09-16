from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_github_token_status_route_exists():
    response = client.get('/api/v1/github/token/status')
    assert response.status_code == 200
    assert response.json() == {'connected': False}


def test_github_token_and_connect_routes_exist():
    token_response = client.post('/api/v1/github/token', json={'token': 'test-token'})
    assert token_response.status_code == 200

    connect_response = client.post(
        '/api/v1/github/connect',
        json={'projectId': 'proj-1', 'owner': 'octocat', 'repo': 'hello-world', 'branch': 'main'},
    )
    assert connect_response.status_code == 200
    payload = connect_response.json()
    assert payload['repositoryUrl'] == 'https://github.com/octocat/hello-world'
    assert payload['defaultBranch'] == 'main'
